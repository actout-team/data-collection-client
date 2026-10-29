import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const appName = 'ActOut Collect Client';

export function configureApp(app) {
  const directory = path.join(app.getPath('appData'), appName);
  // Compatibility only: reuse existing settings and models after the rename.
  const previous = ['agentsim-collect', 'AgentSim Collect']
    .map(name => path.join(app.getPath('appData'), name)).find(existsSync);
  const userData = existsSync(directory) ? directory : previous || directory;
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setName(appName);
}
