// Configure environment variables for tests
process.env.MOCK_MODE = 'true';
process.env.NODE_ENV = 'test';
process.env.AZURE_TENANT_ID = 'test-tenant';
process.env.AZURE_CLIENT_ID = 'test-client';
process.env.EMASS_CONFIG_ENCRYPTION_KEY = 'test-only-emass-config-key';
