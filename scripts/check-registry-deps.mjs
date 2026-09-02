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
// other, so ranges are compared regardless of section; the section is kept
// only to name where each range was found in a message.
function rangesBySection(manifest) {
  const bySection = new Map()
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      bySection.set(name, { section, range })
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

for (const name of sharedNames) {
  const root = rootRanges.get(name)
  const registry = registryRanges.get(name)
  if (root.range !== registry.range) {
    failures.push(
      `${name} is "${root.range}" in package.json ("${root.section}") and "${registry.range}" in registry/package.json ("${registry.section}"); make the two ranges identical.`,
    )
  }
}

for (const field of ['node', 'type']) {
  const rootValue = field === 'node' ? rootManifest.engines?.node : rootManifest.type
  const registryValue = field === 'node' ? registryManifest.engines?.node : registryManifest.type
  const label = field === 'node' ? 'engines.node' : 'type'
  if (rootValue !== registryValue) {
    failures.push(
      `${label} is ${JSON.stringify(rootValue)} in package.json and ${JSON.stringify(registryValue)} in registry/package.json; make the two identical.`,
    )
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
    continue
  }
  if (!registryEntry) {
    failures.push(
      `${name} is declared in both manifests but has no "node_modules/${name}" entry in registry/package-lock.json; run npm install to refresh it.`,
    )
    continue
  }
  if (rootEntry.version !== registryEntry.version) {
    failures.push(
      `${name} resolves to ${rootEntry.version} in package-lock.json and ${registryEntry.version} in registry/package-lock.json; regenerate one lockfile so both trees run the same code.`,
    )
    continue
  }
  resolvedMatches += 1
}

if (failures.length > 0) {
  console.error('the root and registry/ packages disagree:')
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log(
  `manifests agree: ${sharedNames.length} packages named in both carry identical ranges, ${resolvedMatches} resolve to the same version in both lockfiles, engines.node and type match`,
)
