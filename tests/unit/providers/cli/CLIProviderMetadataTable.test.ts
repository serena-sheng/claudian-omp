import * as fs from 'node:fs';
import * as path from 'node:path';

import { CLI_PROVIDER_METADATA } from '@/providers/cli/CLIProviderMetadataTable';

const providersRoot = path.join(process.cwd(), 'src', 'providers');

function registeredProviderIds(): string[] {
  return fs.readdirSync(providersRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory()
      && fs.existsSync(path.join(providersRoot, entry.name, 'registration.ts')))
    .map(entry => entry.name)
    .sort();
}

it('registers CLI metadata for every registered provider and nothing else', () => {
  expect(Object.keys(CLI_PROVIDER_METADATA).sort()).toEqual(registeredProviderIds());
});

it('gives every provider a resolvable binary and an npm package for version checks', () => {
  for (const [providerId, metadata] of Object.entries(CLI_PROVIDER_METADATA)) {
    expect(metadata.binaryName.trim()).not.toBe('');
    expect(metadata.displayName.trim()).not.toBe('');
    expect(metadata.npmPackage).toBeTruthy();
    expect(providerId).toBeTruthy();
  }
});

it('keeps each provider metadata module next to the provider that owns it', () => {
  for (const providerId of registeredProviderIds()) {
    const runtimeDir = path.join(providersRoot, providerId, 'runtime');
    const metadataFiles = fs.readdirSync(runtimeDir).filter(name => name.endsWith('CLIMetadata.ts'));
    expect(metadataFiles).toHaveLength(1);
  }
});
