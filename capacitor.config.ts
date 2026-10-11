import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.avenium.taskmanager',
  appName: 'Avenium Tasks',
  webDir: 'public',
  server: {
    url: 'https://tasks.avenium.com',
    cleartext: false
  },
  android: {
    backgroundColor: '#6b8f79',
    allowMixedContent: false
  }
};

export default config;
