/**
 * @file prototype-rabbitmq-sdk.js
 * @description Prototype of the new libs/events-broker SDK for RabbitMQ
 */

// Publish an event
async function publishEvent(eventType, correlationId, payload) {
  // 1. Validates payload against schema internally
  // 2. Publishes to the main RabbitMQ exchange (e.g., 'platform_events')
  // 3. Routing key is the eventType
}

// Consume events (Worker definition)
async function createConsumer(queueName, routingKeys, handlerFunction, options = {}) {
  // Default options for robust error handling
  const config = {
    prefetch: options.prefetch || 10,
    retryCount: options.retryCount || 3,       // How many times to retry before DLQ
    retryDelayMs: options.retryDelayMs || 5000 // Delay between retries
  };

  // 1. Asserts primary queue and binds to 'platform_events' exchange via routingKeys
  // 2. Asserts retry queue (with TTL = retryDelayMs) routed back to primary
  // 3. Asserts final DLQ (Dead Letter Queue) for messages that exhaust retryCount
  // 4. Consumes messages:
  //    - If handlerFunction succeeds -> ACK
  //    - If handlerFunction throws & retries left -> NACK (routes to retry queue)
  //    - If handlerFunction throws & retries exhausted -> NACK (routes to final DLQ)
}

// Usage in context-personal (e.g., insight-sent)
createConsumer(
  'context_personal_insight_sent_queue', 
  ['ENRICHED_INSIGHT_SENT_EVENT'], 
  async (message) => {
    const { correlationId, eventType, payload } = message;
    // Process event...
    // Throwing an error automatically triggers the retry/DLQ mechanism
  }
);
