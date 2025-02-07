/* eslint-disable no-nested-ternary */
import fs from 'fs';
import { printSchema } from 'graphql';
import Logger from '../utilities/logger';
import loadConfig from '../config/load';
import payload from '..';

export function generateGraphQLSchema(): void {
  const logger = Logger();
  const config = loadConfig();

  payload.init({
    secret: '--unused--',
    mongoURL: false,
    local: true,
  });

  logger.info('Compiling GraphQL schema...');
  fs.writeFileSync(config.graphQL.schemaOutputFile, printSchema(payload.schema));
  logger.info(`GraphQL written to ${config.typescript.outputFile}`);
}

// when generateGraphQLSchema.js is launched directly
if (module.id === require.main.id) {
  generateGraphQLSchema();
}
