import express, { Express, Response, Router } from 'express';
import pino from 'pino';
import crypto from 'crypto';
import { GraphQLError, GraphQLFormattedError, GraphQLSchema } from 'graphql';
import {
  TypeWithID,
  Collection,
  CollectionModel,
} from './collections/config/types';
import {
  SanitizedConfig,
  EmailOptions,
  InitOptions,
} from './config/types';
import { TypeWithVersion } from './versions/types';
import { PaginatedDocs } from './mongoose/types';

import Logger from './utilities/logger';
import loadConfig from './config/load';
import authenticate, { PayloadAuthenticate } from './express/middleware/authenticate';
import connectMongoose from './mongoose/connect';
import expressMiddleware from './express/middleware';
import initAdmin from './express/admin';
import initAuth from './auth/init';
import access from './auth/requestHandlers/access';
import initCollections from './collections/init';
import initPreferences from './preferences/init';
import initGlobals from './globals/init';
import { Globals, TypeWithID as GlobalTypeWithID } from './globals/config/types';
import initGraphQLPlayground from './graphql/initPlayground';
import initStatic from './express/static';
import registerSchema from './graphql/registerSchema';
import graphQLHandler from './graphql/graphQLHandler';
import buildEmail from './email/build';
import identifyAPI from './express/middleware/identifyAPI';
import errorHandler, { ErrorHandler } from './express/middleware/errorHandler';
import localOperations from './collections/operations/local';
import localGlobalOperations from './globals/operations/local';
import { encrypt, decrypt } from './auth/crypto';
import { BuildEmailResult, Message } from './email/types';
import { PayloadRequest } from './express/types';
import sendEmail from './email/sendEmail';
import { Preferences } from './preferences/types';

import { Options as CreateOptions } from './collections/operations/local/create';
import { Options as FindOptions } from './collections/operations/local/find';
import { Options as FindByIDOptions } from './collections/operations/local/findByID';
import { Options as UpdateOptions } from './collections/operations/local/update';
import { Options as DeleteOptions } from './collections/operations/local/delete';
import { Options as FindVersionsOptions } from './collections/operations/local/findVersions';
import { Options as FindVersionByIDOptions } from './collections/operations/local/findVersionByID';
import { Options as RestoreVersionOptions } from './collections/operations/local/restoreVersion';
import { Options as FindGlobalVersionsOptions } from './globals/operations/local/findVersions';
import { Options as FindGlobalVersionByIDOptions } from './globals/operations/local/findVersionByID';
import { Options as RestoreGlobalVersionOptions } from './globals/operations/local/restoreVersion';
import { Options as ForgotPasswordOptions } from './auth/operations/local/forgotPassword';
import { Options as LoginOptions } from './auth/operations/local/login';
import { Options as ResetPasswordOptions } from './auth/operations/local/resetPassword';
import { Options as UnlockOptions } from './auth/operations/local/unlock';
import { Options as VerifyEmailOptions } from './auth/operations/local/verifyEmail';
import { Result as ForgotPasswordResult } from './auth/operations/forgotPassword';
import { Result as ResetPasswordResult } from './auth/operations/resetPassword';
import { Result as LoginResult } from './auth/operations/login';
import { Options as FindGlobalOptions } from './globals/operations/local/findOne';
import { Options as UpdateGlobalOptions } from './globals/operations/local/update';
import { serverInit as serverInitTelemetry } from './utilities/telemetry/events/serverInit';

require('isomorphic-fetch');

/**
 * @description Payload
 */
export class Payload {
  config: SanitizedConfig;

  collections: {
    [slug: string]: Collection;
  } = {}

  versions: {
    [slug: string]: CollectionModel;
  } = {}

  preferences: Preferences;

  globals: Globals;

  logger: pino.Logger;

  express: Express

  router: Router;

  emailOptions: EmailOptions;

  email: BuildEmailResult;

  sendEmail: (message: Message) => Promise<unknown>;

  secret: string;

  mongoURL: string | false;

  local: boolean;

  encrypt = encrypt;

  decrypt = decrypt;

  errorHandler: ErrorHandler;

  authenticate: PayloadAuthenticate;

  types: {
    blockTypes: any;
    blockInputTypes: any;
    localeInputType?: any;
    fallbackLocaleInputType?: any;
  };

  Query: { name: string; fields: { [key: string]: any } } = { name: 'Query', fields: {} };

  Mutation: { name: string; fields: { [key: string]: any } } = { name: 'Mutation', fields: {} };

  schema: GraphQLSchema;

  extensions: (info: any) => Promise<any>;

  customFormatErrorFn: (error: GraphQLError) => GraphQLFormattedError;

  validationRules: any;

  errorResponses: GraphQLFormattedError[] = [];

  errorIndex: number;

  /**
   * @description Initializes Payload
   * @param options
   */
  init(options: InitOptions): void {
    this.logger = Logger('payload', options.loggerOptions);
    this.logger.info('Starting Payload...');
    if (!options.secret) {
      throw new Error(
        'Error: missing secret key. A secret key is needed to secure Payload.',
      );
    }

    if (options.mongoURL !== false && typeof options.mongoURL !== 'string') {
      throw new Error('Error: missing MongoDB connection URL.');
    }

    this.emailOptions = { ...(options.email) };
    this.secret = crypto
      .createHash('sha256')
      .update(options.secret)
      .digest('hex')
      .slice(0, 32);

    this.mongoURL = options.mongoURL;
    this.local = options.local;

    this.config = loadConfig(this.logger);

    // If not initializing locally, scaffold router
    if (!this.local) {
      this.router = express.Router();
      this.router.use(...expressMiddleware(this));
      initAuth(this);
    }

    // Configure email service
    this.email = buildEmail(this.emailOptions, this.logger);
    this.sendEmail = sendEmail.bind(this);

    // Initialize collections & globals
    initCollections(this);
    initGlobals(this);

    // Connect to database
    if (this.mongoURL) {
      connectMongoose(this.mongoURL, options.mongoOptions, options.local, this.logger);
    }

    if (!this.config.graphQL.disable) {
      registerSchema(this);
    }
    // If not initializing locally, set up HTTP routing
    if (!this.local) {
      options.express.use((req: PayloadRequest, res, next) => {
        req.payload = this;
        next();
      });

      this.express = options.express;

      if (this.config.rateLimit.trustProxy) {
        this.express.set('trust proxy', 1);
      }

      initAdmin(this);
      initPreferences(this);

      this.router.get('/access', access);

      if (!this.config.graphQL.disable) {
        this.router.use(
          this.config.routes.graphQL,
          identifyAPI('GraphQL'),
          (req: PayloadRequest, res: Response) => graphQLHandler(req, res)(req, res),
        );
        initGraphQLPlayground(this);
      }

      // Bind router to API
      this.express.use(this.config.routes.api, this.router);

      // Enable static routes for all collections permitting upload
      initStatic(this);

      this.errorHandler = errorHandler(this.config, this.logger);
      this.router.use(this.errorHandler);

      this.authenticate = authenticate(this.config);
    }

    if (typeof options.onInit === 'function') options.onInit(this);

    serverInitTelemetry(this);
  }

  getAdminURL = (): string => `${this.config.serverURL}${this.config.routes.admin}`;

  getAPIURL = (): string => `${this.config.serverURL}${this.config.routes.api}`;

  /**
   * @description Performs create operation
   * @param options
   * @returns created document
   */
  create = async <T = any>(options: CreateOptions<T>): Promise<T> => {
    const { create } = localOperations;
    return create(this, options);
  }

  /**
   * @description Find documents with criteria
   * @param options
   * @returns documents satisfying query
   */
  find = async <T extends TypeWithID = any>(options: FindOptions): Promise<PaginatedDocs<T>> => {
    const { find } = localOperations;
    return find(this, options);
  }

  findGlobal = async <T extends GlobalTypeWithID = any>(options: FindGlobalOptions): Promise<T> => {
    const { findOne } = localGlobalOperations;
    return findOne(this, options);
  }

  updateGlobal = async <T extends GlobalTypeWithID = any>(options: UpdateGlobalOptions): Promise<T> => {
    const { update } = localGlobalOperations;
    return update(this, options);
  }

  /**
   * @description Find global versions with criteria
   * @param options
   * @returns versions satisfying query
   */
  findGlobalVersions = async <T extends TypeWithVersion<T> = any>(options: FindGlobalVersionsOptions): Promise<PaginatedDocs<T>> => {
    const { findVersions } = localGlobalOperations;
    return findVersions<T>(this, options);
  }

  /**
   * @description Find global version by ID
   * @param options
   * @returns global version with specified ID
   */
  findGlobalVersionByID = async <T extends TypeWithVersion<T> = any>(options: FindGlobalVersionByIDOptions): Promise<T> => {
    const { findVersionByID } = localGlobalOperations;
    return findVersionByID(this, options);
  }

  /**
   * @description Restore global version by ID
   * @param options
   * @returns version with specified ID
   */
  restoreGlobalVersion = async <T extends TypeWithVersion<T> = any>(options: RestoreGlobalVersionOptions): Promise<T> => {
    const { restoreVersion } = localGlobalOperations;
    return restoreVersion(this, options);
  }

  /**
   * @description Find document by ID
   * @param options
   * @returns document with specified ID
   */
  findByID = async <T extends TypeWithID = any>(options: FindByIDOptions): Promise<T> => {
    const { findByID } = localOperations;
    return findByID<T>(this, options);
  }

  /**
   * @description Update document
   * @param options
   * @returns Updated document
   */
  update = async <T = any>(options: UpdateOptions<T>): Promise<T> => {
    const { update } = localOperations;
    return update<T>(this, options);
  }

  delete = async <T extends TypeWithID = any>(options: DeleteOptions): Promise<T> => {
    const { localDelete } = localOperations;
    return localDelete<T>(this, options);
  }

  /**
   * @description Find versions with criteria
   * @param options
   * @returns versions satisfying query
   */
  findVersions = async <T extends TypeWithVersion<T> = any>(options: FindVersionsOptions): Promise<PaginatedDocs<T>> => {
    const { findVersions } = localOperations;
    return findVersions<T>(this, options);
  }

  /**
   * @description Find version by ID
   * @param options
   * @returns version with specified ID
   */
  findVersionByID = async <T extends TypeWithVersion<T> = any>(options: FindVersionByIDOptions): Promise<T> => {
    const { findVersionByID } = localOperations;
    return findVersionByID(this, options);
  }

  /**
   * @description Restore version by ID
   * @param options
   * @returns version with specified ID
   */
  restoreVersion = async <T extends TypeWithVersion<T> = any>(options: RestoreVersionOptions): Promise<T> => {
    const { restoreVersion } = localOperations;
    return restoreVersion(this, options);
  }

  login = async <T extends TypeWithID = any>(options: LoginOptions): Promise<LoginResult & { user: T}> => {
    const { login } = localOperations.auth;
    return login(this, options);
  }

  forgotPassword = async (options: ForgotPasswordOptions): Promise<ForgotPasswordResult> => {
    const { forgotPassword } = localOperations.auth;
    return forgotPassword(this, options);
  }

  resetPassword = async (options: ResetPasswordOptions): Promise<ResetPasswordResult> => {
    const { resetPassword } = localOperations.auth;
    return resetPassword(this, options);
  }

  unlock = async (options: UnlockOptions): Promise<boolean> => {
    const { unlock } = localOperations.auth;
    return unlock(this, options);
  }

  verifyEmail = async (options: VerifyEmailOptions): Promise<boolean> => {
    const { verifyEmail } = localOperations.auth;
    return verifyEmail(this, options);
  }
}

const payload = new Payload();

export default payload;
module.exports = payload;
