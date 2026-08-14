import { resolveUserContext, DEFAULT_ROLE } from './authContext.js';
import assert from 'assert';

function makeClient(userId, role, error = null) {
  let queryColumn = null;
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: userId } }, error }),
    },
    from: () => ({
      select: () => ({
        eq: (column) => {
          queryColumn = column;
          return {
            maybeSingle: async () => ({ data: role ? { role } : null, error: null }),
          };
        },
      }),
    }),
    _queryColumn: () => queryColumn,
  };
}

console.log('Testing GraphQL Gateway auth context...');

const driverClient = makeClient('driver-uid-abc', 'driver');
const driverCtx = await resolveUserContext(driverClient, 'Bearer token');
assert.strictEqual(driverCtx.id, 'driver-uid-abc');
assert.strictEqual(driverCtx.role, 'driver');
assert.strictEqual(driverClient._queryColumn(), 'firebase_uid');

const adminClient = makeClient('admin-uid-xyz', 'admin');
const adminCtx = await resolveUserContext(adminClient, 'token');
assert.strictEqual(adminCtx.role, 'admin');

const noProfileClient = makeClient('customer-uid-123', null);
const customerCtx = await resolveUserContext(noProfileClient, 'Bearer token');
assert.strictEqual(customerCtx.role, DEFAULT_ROLE);
assert.strictEqual(customerCtx.role, 'CUSTOMER');

assert.strictEqual(await resolveUserContext(driverClient, null), null);
assert.strictEqual(await resolveUserContext(driverClient, ''), null);

const errorClient = makeClient('uid', null, new Error('bad token'));
assert.strictEqual(await resolveUserContext(errorClient, 'token'), null);

console.log('✅ GraphQL Gateway auth context tests passed successfully.');
