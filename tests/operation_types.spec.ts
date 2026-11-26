import { test } from '@japa/runner'
import type { ExecuteInput, Operation, RequestIdentity } from '../index.ts'

function acceptOperation<Payload, Authorization, Result>(
  operation: Operation<Payload, Authorization, Result>
) {
  return operation
}

test('the authorization parser is required only when authorization excludes undefined', ({
  expectTypeOf,
}) => {
  expectTypeOf<Operation<{}, string, string>>()
    .toHaveProperty('parseAuthorization')
    .toEqualTypeOf<(raw: unknown) => string>()
  expectTypeOf<Operation<{}, undefined, null>>()
    .toHaveProperty('parseAuthorization')
    .toEqualTypeOf<((raw: unknown) => undefined) | undefined>()

  const parserless: Operation<{}, undefined, null> = {
    name: 'typed.parserless',
    authorizeAccess() {},
    work(_context, authorization) {
      expectTypeOf(authorization).toEqualTypeOf<undefined>()
      return null
    },
  }
  expectTypeOf(parserless).toMatchTypeOf<Operation<{}, undefined, null>>()
})

test('the parser infers the authorization type passed to both execution callbacks', ({
  expectTypeOf,
}) => {
  const inferred = acceptOperation({
    name: 'typed.inferred',
    authorizeAccess() {},
    parseAuthorization: () => 'proof',
    authorizeExecute(_context, authorization) {
      expectTypeOf(authorization).toEqualTypeOf<string>()
    },
    work(_context, authorization) {
      expectTypeOf(authorization).toEqualTypeOf<string>()
      return authorization.toUpperCase()
    },
  })
  expectTypeOf(inferred.work).returns.toEqualTypeOf<Promise<string> | string>()
  expectTypeOf<ExecuteInput<{}>>()
    .toHaveProperty('requestIdentity')
    .toEqualTypeOf<RequestIdentity>()
})
