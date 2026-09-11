import { app, services } from './app.js';

const PORT = process.env.PORT || 3000;

// Create webhook endpoint for testing (optional)
async function setupTestWebhook(): Promise<void> {
  try {
    const testTenantId = 'test-tenant';

    // Check if webhook already exists
    const endpoints = await services.webhooks.listWebhookEndpoints(testTenantId);
    if (endpoints.length > 0) {
      console.log(`✓ Test webhook endpoint already exists`);
      return;
    }

    // Create test webhook endpoint
    const { endpoint } = await services.webhooks.createWebhookEndpoint({
      tenantId: testTenantId,
      url: 'http://localhost:4000/webhook-receiver',
      events: ['invoice.created'],
      createdBy: 'system',
    });

    console.log(`✓ Created test webhook endpoint: ${endpoint.id}`);
  } catch (error) {
    // Webhook setup optional for server startup
    console.log('Note: Could not setup test webhook, continuing anyway');
  }
}

// Start server
async function start(): Promise<void> {
  try {
    // Setup optional test webhook
    await setupTestWebhook();

    // Start Express server
    app.listen(PORT, () => {
      console.log(`\n✓ Invoice Application listening on http://localhost:${PORT}`);
      console.log(`\n  Endpoints:`);
      console.log(`  POST   /customers           Create customer`);
      console.log(`  GET    /customers           List customers`);
      console.log(`  POST   /invoices            Create invoice (atomic: state + webhook + job)`);
      console.log(`  GET    /invoices            List invoices`);
      console.log(`  GET    /invoices/:id        Get invoice`);
      console.log(`  GET    /health              Health check`);
      console.log(`\n  AppPort Services:`);
      console.log(`  - API Keys for authentication`);
      console.log(`  - Webhooks for invoice.created events`);
      console.log(`  - Jobs for invoice processing`);
      console.log(`  - All persisted in one FeltDB runtime\n`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
