#!/usr/bin/env node
//
// check-registry-deps.mjs - the root package.json ships registry/dist as its
// bin, so a consumer install resolves the service's imports against the root
// dependency list, while every test suite that vetted that code ran against
// registry/package.json's list. The two are deliberate duplicates: this
// guard fails when they drift apart, in either the declared ranges or the
// versions each lockfile actually resolved.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const rootManifest = readJson(resolve(repoRoot, 'package.json'))
const registryManifest = readJson(resolve(repoRoot, 'registry/package.json'))
const rootLock = readJson(resolve(repoRoot, 'package-lock.json'))
const registryLock = readJson(resolve(repoRoot, 'registry/package-lock.json'))

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

// A package can be a runtime dep on one side and a devDependency on the
// other, so ranges are compared regardless of section. Every occurrence is
// kept rather than the last one seen: a name declared in two sections of one
// manifest would otherwise shadow itself, and the surviving entry can agree
// across the two files while the shadowed one drifts.
function rangesBySection(manifest) {
  const bySection = new Map()
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      const occurrences = bySection.get(name) ?? []
      occurrences.push({ section, range })
      bySection.set(name, occurrences)
    }
  }
  return bySection
}

const rootRanges = rangesBySection(rootManifest)
const registryRanges = rangesBySection(registryManifest)

const failures = []

for (const name of Object.keys(rootManifest.dependencies ?? {})) {
  if (!(name in (registryManifest.dependencies ?? {}))) {
    failures.push(
      `${name} is a runtime dependency of package.json but is not in registry/package.json's "dependencies"; no suite installs it. Add it to registry/package.json.`,
    )
  }
}

for (const name of Object.keys(registryManifest.dependencies ?? {})) {
  if (!(name in (rootManifest.dependencies ?? {}))) {
    failures.push(
      `${name} is a runtime dependency of registry/package.json but is not in the root "dependencies"; a consumer install would not resolve it. Add it to package.json.`,
    )
  }
}

const sharedNames = [...rootRanges.keys()].filter((name) => registryRanges.has(name)).sort()

// A manifest naming one package at two ranges is incoherent on its own, and
// reporting that as a cross-manifest disagreement would point at the wrong file.
for (const [file, ranges] of [
  ['package.json', rootRanges],
  ['registry/package.json', registryRanges],
]) {
  for (const [name, [first, ...rest]] of ranges) {
    for (const other of rest) {
      if (other.range !== first.range) {
        failures.push(
          `${name} is "${first.range}" in ${file}'s "${first.section}" and "${other.range}" in its "${other.section}"; a manifest cannot name one package at two ranges.`,
        )
      }
    }
  }
}

for (const name of sharedNames) {
  for (const root of rootRanges.get(name)) {
    for (const registry of registryRanges.get(name)) {
      if (root.range !== registry.range) {
        failures.push(
          `${name} is "${root.range}" in package.json ("${root.section}") and "${registry.range}" in registry/package.json ("${registry.section}"); make the two ranges identical.`,
        )
      }
    }
  }
}

// Absence on both sides is a disagreement with npm's defaults rather than
// between the two files: an omitted "type" means commonjs, which the compiled
// ESM bin cannot be loaded under, and an omitted floor lets a consumer install
// on a runtime the closure does not support.
const FIELDS = [
  { label: 'engines.node', read: (manifest) => manifest.engines?.node },
  { label: 'type', read: (manifest) => manifest.type },
]

for (const { label, read } of FIELDS) {
  const rootValue = read(rootManifest)
  const registryValue = read(registryManifest)
  if (rootValue !== registryValue) {
    failures.push(
      `${label} is ${JSON.stringify(rootValue)} in package.json and ${JSON.stringify(registryValue)} in registry/package.json; make the two identical.`,
    )
  } else if (rootValue === undefined) {
    failures.push(`${label} is missing from both package.json and registry/package.json; set it in both.`)
  }
}

let resolvedMatches = 0
for (const name of sharedNames) {
  const rootEntry = rootLock.packages?.[`node_modules/${name}`]
  const registryEntry = registryLock.packages?.[`node_modules/${name}`]
  if (!rootEntry) {
    failures.push(
      `${name} is declared in both manifests but has no "node_modules/${name}" entry in package-lock.json; run npm install to refresh it.`,
    )
  }
  if (!registryEntry) {
    failures.push(
      `${name} is declared in both manifests but has no "node_modules/${name}" entry in registry/package-lock.json; run npm install to refresh it.`,
    )
  }
  if (!rootEntry || !registryEntry) continue
  if (rootEntry.version !== registryEntry.version) {
    // A plain npm install keeps any locked resolution that still satisfies the
    // range, so it leaves this untouched; rebuilding the lockfile from scratch
    // is what moves it. Naming the version instead (npm install pkg@version)
    // also rewrites the manifest range, and when neither tree holds the newest
    // version the ranges allow, both lockfiles have to be rebuilt.
    failures.push(
      `${name} resolves to ${rootEntry.version} in package-lock.json and ${registryEntry.version} in registry/package-lock.json; npm install keeps a resolution that still satisfies the range, so delete the lockfile you are correcting and reinstall.`,
    )
    continue
  }
  resolvedMatches += 1
}

// Making two ranges identical satisfies the rule above while leaving each
// lockfile recording the range it was generated from, and npm ci refuses a tree
// in that state. Comparing the root entry npm writes into every lockfile against
// the manifest beside it is the cheap half of what npm ci validates.
const TREES = [
  {
    manifest: rootManifest,
    manifestFile: 'package.json',
    lock: rootLock,
    lockFile: 'package-lock.json',
  },
  {
    manifest: registryManifest,
    manifestFile: 'registry/package.json',
    lock: registryLock,
    lockFile: 'registry/package-lock.json',
  },
]

for (const { manifest, manifestFile, lock, lockFile } of TREES) {
  const recorded = lock.packages?.[''] ?? {}
  for (const section of SECTIONS) {
    const declared = manifest[section] ?? {}
    const locked = recorded[section] ?? {}
    for (const [name, range] of Object.entries(declared)) {
      if (locked[name] !== range) {
        const recordedRange =
          locked[name] === undefined ? 'does not record it' : `records "${locked[name]}"`
        failures.push(
          `${name} is "${range}" in ${manifestFile}'s "${section}" but ${lockFile} ${recordedRange}; run npm install to bring the lockfile up to date.`,
        )
      }
    }
    for (const name of Object.keys(locked)) {
      if (!(name in declared)) {
        failures.push(
          `${lockFile} still records ${name} in "${section}" but ${manifestFile} no longer declares it; run npm install to bring the lockfile up to date.`,
        )
      }
    }
  }
}

if (failures.length > 0) {
  console.error('the root and registry/ packages disagree:')
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log(
  `manifests agree: ${sharedNames.length} packages named in both carry identical ranges, ${resolvedMatches} resolve to the same version in both lockfiles, engines.node and type match, and each lockfile records the manifest beside it`,
)
