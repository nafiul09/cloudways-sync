// Canned Cloudways API response bodies for unit tests. Shaped to
// match what Cloudways v2 actually returns (numeric IDs as strings,
// apps nested in servers, etc.) so schema coercion is exercised.

export const oauthTokenResponse = {
  access_token: 'test-access-token-abc123',
  expires_in: 3600,
  token_type: 'Bearer',
};

export const serversResponse = {
  servers: [
    {
      id: '12345',
      label: 'prod-wp-server',
      cloud: 'do',
      region: 'nyc3',
      size: '2GB',
      public_ip: '203.0.113.10',
      server_fqdn: 'wordpress-12345.cloudwaysapps.com',
      master_user: 'master_abc',
      status: 'running',
      platform: 'ubuntu20',
      apps: [
        {
          id: '67890',
          label: 'Main WordPress',
          application: 'wordpress',
          app_version: '6.4.2',
          app_fqdn: 'wordpress-67890.cloudwaysapps.com',
          app_user: 'app_user_xyz',
          sys_user: 'app_user_xyz',
          cname: 'www.example.com',
          mysql_db_name: 'app_main_wp',
          mysql_user: 'app_main_wp',
          created_at: '2024-01-10 12:00:00',
        },
      ],
    },
    {
      id: '99999',
      label: 'staging-server',
      cloud: 'vultr',
      apps: [],
    },
  ],
};

export const appCredsResponse = {
  app_creds: [
    {
      id: '1',
      sys_user: 'app_user_xyz',
      ssh_keys: [],
      password: 'secret-password',
    },
  ],
};

export const operationTriggerResponse = {
  operation_id: '555666',
};

export const operationProcessingResponse = {
  operation: {
    id: '555666',
    type: 'app_backup',
    status: 'Processing',
    is_completed: 0,
    message: '',
    estimated_time_remaining: 60,
  },
};

export const operationCompletedResponse = {
  operation: {
    id: '555666',
    type: 'app_backup',
    status: 'Completed',
    is_completed: 1,
    message: 'Backup completed successfully',
    estimated_time_remaining: 0,
  },
};

export const operationFailedResponse = {
  operation: {
    id: '555666',
    type: 'app_backup',
    status: 'Failed',
    is_completed: 1,
    message: 'Disk full',
    estimated_time_remaining: 0,
  },
};
