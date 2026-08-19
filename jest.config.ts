import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  // Map the contracts package to its TypeScript source so tests run without
  // a pre-built dist/ — the symlink from `npm install` must exist first.
  moduleNameMapper: {
    '^@demo/contracts$': '<rootDir>/node_modules/@demo/contracts/src/index.ts',
    '^@demo/contracts/(.*)$': '<rootDir>/node_modules/@demo/contracts/src/$1.ts',
  },
};

export default config;
