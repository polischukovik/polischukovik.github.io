const AUTH_BOOTSTRAP_SETTINGS = {
  environment: 'mypurecloud.ie',
  clientId: '0fa528a7-e1dc-42e1-b3a2-c6bed4ae4421',
  scopes: [
    'analytics:readonly',
    'content-management:readonly',
    'architect:readonly',
    'routing:readonly',
    'users:readonly',
    'outbound:readonly',
    'authorization:readonly',
  ].join(' '),
};

export {
  AUTH_BOOTSTRAP_SETTINGS,
};
