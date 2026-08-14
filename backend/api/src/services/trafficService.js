import logger from '../middleware/logger.js';

const MAX_SURGE_MULTIPLIER = 2.5;

/**
 * Calculates a live traffic multiplier for a given pickup location.
 * Derives the multiplier from TOMTOM/Google Maps real-time traffic data only.
 * Returns 1.0 (no surge) when no API key is configured, the request fails,
 * or the API reports no congestion.
 *
 * @param {number} pickupLat - Pickup latitude
 * @param {number} pickupLng - Pickup longitude
 * @returns {Promise<number>} Traffic multiplier (1.0 to 2.5), or 1.0 on error
 */
export async function getLiveTrafficMultiplier(pickupLat, pickupLng) {
  try {
    if (!pickupLat || !pickupLng) {
      return 1.0;
    }

    const apiKey = process.env.TOMTOM_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

    let multiplier;

    if (apiKey) {
      if (process.env.TOMTOM_API_KEY) {
        const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?key=${process.env.TOMTOM_API_KEY}&point=${pickupLat},${pickupLng}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`TomTom API error: ${response.status}`);
        const data = await response.json();
        const speedDiff = data.flowSegmentData?.speedDiffPercent || 0;
        multiplier = Math.min(MAX_SURGE_MULTIPLIER, Math.max(1.0, 1.0 + Math.max(0, speedDiff / 100)));
      } else {
        const origin = `${pickupLat},${pickupLng}`;
        const destination = `${pickupLat + 0.01},${pickupLng + 0.01}`;
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destination}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Google API error: ${response.status}`);
        const data = await response.json();
        const duration = data.rows?.[0]?.elements?.[0]?.duration_in_traffic?.value;
        const normalDuration = data.rows?.[0]?.elements?.[0]?.duration?.value;
        if (duration && normalDuration && normalDuration > 0) {
          multiplier = Math.min(MAX_SURGE_MULTIPLIER, Math.max(1.0, duration / normalDuration));
        } else {
          multiplier = 1.0;
        }
      }
    } else {
      // No traffic API key configured -- there is no real traffic data to base a
      // surge on, so pricing stays neutral (1.0) instead of applying a
      // fabricated rush-hour surge.
      multiplier = 1.0;
    }

    if (multiplier > 1.0) {
      logger.info(`[TrafficService] Live traffic data at ${pickupLat},${pickupLng}: x${Number(multiplier).toFixed(2)}`);
    }
    return Number(multiplier.toFixed(2));
  } catch (error) {
    logger.error({ err: error }, '[TrafficService] Error fetching live traffic data -- returning 1.0');
    return 1.0;
  }
}
