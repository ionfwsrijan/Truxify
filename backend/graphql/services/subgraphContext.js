import logger from '../../api/src/middleware/logger.js';
import { createUserClient, supabase } from '../../api/src/config/db.js';

export function buildSubgraphContext({ req }) {
    const headers = req?.headers || {};
    const authorization = headers.authorization || headers.Authorization || '';
    const userId = headers['x-user-id'] || headers['X-User-Id'];
    const userRole = headers['x-user-role'] || headers['X-User-Role'];

    const user = userId ? { id: userId, role: userRole || undefined } : null;

    let supabaseClient = supabase;
    if (authorization) {
        try {
            const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : authorization;
            supabaseClient = createUserClient(token);
        } catch (err) {
            logger.warn('[GraphQL] Failed to create per-request Supabase client, falling back to shared client:', err.message);
        }
    }

    return { user, supabase: supabaseClient };
}
