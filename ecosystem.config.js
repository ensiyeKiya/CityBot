module.exports = {
  apps: [
    {
      name: 'smartbot-wot-server',
      script: 'dist/index.js',
      instances: 1, // Single instance - WoT server cannot run in cluster mode
      exec_mode: 'fork',
      env_file: '.env', // Load environment from .env file
      env: {
        NODE_ENV: 'production',
        WOT_SMARTBOT_PORT: 8081
      },
      env_production: {
        NODE_ENV: 'production',
        WOT_SMARTBOT_PORT: 8081
      },
      env_development: {
        NODE_ENV: 'development',
        WOT_SMARTBOT_PORT: 8081
      },
      // Scaling configuration
      max_memory_restart: '1G',
      min_uptime: '10s',
      max_restarts: 10,
      
      // Monitoring
      watch: false,
      ignore_watch: ['node_modules', 'logs'],
      
      // Logging
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // Health checks
      health_check_grace_period: 3000,
      health_check_fatal_exceptions: true,
      
      // Auto-restart on file changes (development)
      watch: process.env.NODE_ENV === 'development',
      ignore_watch: ['node_modules', 'logs', '*.log']
    },
    
    {
      name: 'smartbot-llm-thing',
      script: 'dist/llmThing.js',
      instances: 1, // Single instance for web client
      env_file: '.env', // Load environment from .env file
      env: {
        NODE_ENV: 'production',
        WEB_PORT: 3000,
        WOT_SMARTBOT_PORT: 8081
      },
      env_production: {
        NODE_ENV: 'production',
        WEB_PORT: 3000,
        WOT_SMARTBOT_PORT: 8081
      },
      env_development: {
        NODE_ENV: 'development',
        WEB_PORT: 3000,
        WOT_SMARTBOT_PORT: 8081
      },
      
      // Scaling configuration
      max_memory_restart: '512M',
      min_uptime: '10s',
      max_restarts: 5,
      
      // Logging
      log_file: './logs/web-combined.log',
      out_file: './logs/web-out.log',
      error_file: './logs/web-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ],

  deploy: {
    production: {
      user: 'bkraychev',
      host: 'localhost',
      ref: 'origin/main',
      repo: 'git@github.com:ensiyeKiya/citybot-WoT.git',
      path: '/home/bkraychev/apps/smartbot',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    }
  }
}; 