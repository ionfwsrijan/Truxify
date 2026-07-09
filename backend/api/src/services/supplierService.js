import logger from '../middleware/logger.js';
import { DomainError } from './order/domainError.js';

export class SupplierService {
  constructor(orderRepository) {
    this.orderRepository = orderRepository;
  }

  async supplierStatusUpdate({ supplierId, status, orderId, metadata }) {
    if (!supplierId) {
      throw new DomainError(400, { error: 'Supplier ID is required.' });
    }

    const updatePayload = {
      supplier_id: supplierId,
      status,
      updated_at: new Date().toISOString(),
      metadata: metadata || {},
    };

    if (orderId) {
      updatePayload.order_id = orderId;
    }

    const { data, error } = await this.orderRepository.upsertSupplierStatus(updatePayload);

    if (error) {
      logger.error(`[supplier] Status update failed for supplier ${supplierId}:`, error.message);
      throw new DomainError(500, { error: 'Failed to update supplier status.', details: error.message });
    }

    logger.info(`[supplier] Status for ${supplierId} updated to ${status} on order ${orderId || 'N/A'}`);
    return data;
  }
}
