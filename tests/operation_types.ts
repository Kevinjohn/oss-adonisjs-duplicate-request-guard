import type { Operation } from '../index.js'

// A missing parser cannot promise defined authorization to execution or work callbacks.
// @ts-expect-error A string authorization requires a parser.
const missingParser: Operation<{}, string, string> = {
  name: 'typed.missingParser',
  authorizeAccess() {},
  authorizeExecute(_context, authorization) {
    authorization.toUpperCase()
  },
  work(_context, authorization) {
    return authorization.toUpperCase()
  },
}

const parsed: Operation<{}, string, string> = {
  ...missingParser,
  parseAuthorization: () => 'proof',
  work(_context, authorization) {
    return authorization.toUpperCase()
  },
}

const parserless: Operation<{}, undefined, null> = {
  name: 'typed.parserless',
  authorizeAccess() {},
  work(_context, authorization) {
    const absent: undefined = authorization
    return absent ?? null
  },
}

function acceptOperation<Payload, Authorization, Result>(
  operation: Operation<Payload, Authorization, Result>
) {
  return operation
}

const inferred = acceptOperation({
  name: 'typed.inferred',
  authorizeAccess() {},
  parseAuthorization: () => 'proof',
  work(_context, authorization) {
    return authorization.toUpperCase()
  },
})

// These compile-time fixtures never execute as test cases.
void parsed
void parserless
void inferred
