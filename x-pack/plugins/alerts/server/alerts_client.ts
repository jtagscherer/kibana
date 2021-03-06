/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import Boom from 'boom';
import { omit, isEqual, map, uniq, pick, truncate, trim } from 'lodash';
import { i18n } from '@kbn/i18n';
import {
  Logger,
  SavedObjectsClientContract,
  SavedObjectReference,
  SavedObject,
  PluginInitializerContext,
} from 'src/core/server';
import { esKuery } from '../../../../src/plugins/data/server';
import { ActionsClient, ActionsAuthorization } from '../../actions/server';
import {
  Alert,
  PartialAlert,
  RawAlert,
  AlertTypeRegistry,
  AlertAction,
  AlertType,
  IntervalSchedule,
  SanitizedAlert,
  AlertTaskState,
  AlertInstanceSummary,
} from './types';
import { validateAlertTypeParams } from './lib';
import {
  InvalidateAPIKeyParams,
  GrantAPIKeyResult as SecurityPluginGrantAPIKeyResult,
  InvalidateAPIKeyResult as SecurityPluginInvalidateAPIKeyResult,
} from '../../security/server';
import { EncryptedSavedObjectsClient } from '../../encrypted_saved_objects/server';
import { TaskManagerStartContract } from '../../task_manager/server';
import { taskInstanceToAlertTaskInstance } from './task_runner/alert_task_instance';
import { deleteTaskIfItExists } from './lib/delete_task_if_it_exists';
import { RegistryAlertType } from './alert_type_registry';
import { AlertsAuthorization, WriteOperations, ReadOperations, and } from './authorization';
import { IEventLogClient } from '../../../plugins/event_log/server';
import { parseIsoOrRelativeDate } from './lib/iso_or_relative_date';
import { alertInstanceSummaryFromEventLog } from './lib/alert_instance_summary_from_event_log';
import { IEvent } from '../../event_log/server';
import { parseDuration } from '../common/parse_duration';
import { retryIfConflicts } from './lib/retry_if_conflicts';
import { partiallyUpdateAlert } from './saved_objects';

export interface RegistryAlertTypeWithAuth extends RegistryAlertType {
  authorizedConsumers: string[];
}
type NormalizedAlertAction = Omit<AlertAction, 'actionTypeId'>;
export type CreateAPIKeyResult =
  | { apiKeysEnabled: false }
  | { apiKeysEnabled: true; result: SecurityPluginGrantAPIKeyResult };
export type InvalidateAPIKeyResult =
  | { apiKeysEnabled: false }
  | { apiKeysEnabled: true; result: SecurityPluginInvalidateAPIKeyResult };

export interface ConstructorOptions {
  logger: Logger;
  taskManager: TaskManagerStartContract;
  unsecuredSavedObjectsClient: SavedObjectsClientContract;
  authorization: AlertsAuthorization;
  actionsAuthorization: ActionsAuthorization;
  alertTypeRegistry: AlertTypeRegistry;
  encryptedSavedObjectsClient: EncryptedSavedObjectsClient;
  spaceId?: string;
  namespace?: string;
  getUserName: () => Promise<string | null>;
  createAPIKey: (name: string) => Promise<CreateAPIKeyResult>;
  invalidateAPIKey: (params: InvalidateAPIKeyParams) => Promise<InvalidateAPIKeyResult>;
  getActionsClient: () => Promise<ActionsClient>;
  getEventLogClient: () => Promise<IEventLogClient>;
  kibanaVersion: PluginInitializerContext['env']['packageInfo']['version'];
}

export interface MuteOptions extends IndexType {
  alertId: string;
  alertInstanceId: string;
}

export interface FindOptions extends IndexType {
  perPage?: number;
  page?: number;
  search?: string;
  defaultSearchOperator?: 'AND' | 'OR';
  searchFields?: string[];
  sortField?: string;
  sortOrder?: string;
  hasReference?: {
    type: string;
    id: string;
  };
  fields?: string[];
  filter?: string;
}

interface IndexType {
  [key: string]: unknown;
}

export interface FindResult {
  page: number;
  perPage: number;
  total: number;
  data: SanitizedAlert[];
}

export interface CreateOptions {
  data: Omit<
    Alert,
    | 'id'
    | 'createdBy'
    | 'updatedBy'
    | 'createdAt'
    | 'updatedAt'
    | 'apiKey'
    | 'apiKeyOwner'
    | 'muteAll'
    | 'mutedInstanceIds'
    | 'actions'
  > & { actions: NormalizedAlertAction[] };
  options?: {
    migrationVersion?: Record<string, string>;
  };
}

interface UpdateOptions {
  id: string;
  data: {
    name: string;
    tags: string[];
    schedule: IntervalSchedule;
    actions: NormalizedAlertAction[];
    params: Record<string, unknown>;
    throttle: string | null;
  };
}

interface GetAlertInstanceSummaryParams {
  id: string;
  dateStart?: string;
}

export class AlertsClient {
  private readonly logger: Logger;
  private readonly getUserName: () => Promise<string | null>;
  private readonly spaceId?: string;
  private readonly namespace?: string;
  private readonly taskManager: TaskManagerStartContract;
  private readonly unsecuredSavedObjectsClient: SavedObjectsClientContract;
  private readonly authorization: AlertsAuthorization;
  private readonly alertTypeRegistry: AlertTypeRegistry;
  private readonly createAPIKey: (name: string) => Promise<CreateAPIKeyResult>;
  private readonly invalidateAPIKey: (
    params: InvalidateAPIKeyParams
  ) => Promise<InvalidateAPIKeyResult>;
  private readonly getActionsClient: () => Promise<ActionsClient>;
  private readonly actionsAuthorization: ActionsAuthorization;
  private readonly getEventLogClient: () => Promise<IEventLogClient>;
  private readonly encryptedSavedObjectsClient: EncryptedSavedObjectsClient;
  private readonly kibanaVersion!: PluginInitializerContext['env']['packageInfo']['version'];

  constructor({
    alertTypeRegistry,
    unsecuredSavedObjectsClient,
    authorization,
    taskManager,
    logger,
    spaceId,
    namespace,
    getUserName,
    createAPIKey,
    invalidateAPIKey,
    encryptedSavedObjectsClient,
    getActionsClient,
    actionsAuthorization,
    getEventLogClient,
    kibanaVersion,
  }: ConstructorOptions) {
    this.logger = logger;
    this.getUserName = getUserName;
    this.spaceId = spaceId;
    this.namespace = namespace;
    this.taskManager = taskManager;
    this.alertTypeRegistry = alertTypeRegistry;
    this.unsecuredSavedObjectsClient = unsecuredSavedObjectsClient;
    this.authorization = authorization;
    this.createAPIKey = createAPIKey;
    this.invalidateAPIKey = invalidateAPIKey;
    this.encryptedSavedObjectsClient = encryptedSavedObjectsClient;
    this.getActionsClient = getActionsClient;
    this.actionsAuthorization = actionsAuthorization;
    this.getEventLogClient = getEventLogClient;
    this.kibanaVersion = kibanaVersion;
  }

  public async create({ data, options }: CreateOptions): Promise<Alert> {
    await this.authorization.ensureAuthorized(
      data.alertTypeId,
      data.consumer,
      WriteOperations.Create
    );

    // Throws an error if alert type isn't registered
    const alertType = this.alertTypeRegistry.get(data.alertTypeId);

    const validatedAlertTypeParams = validateAlertTypeParams(alertType, data.params);
    const username = await this.getUserName();

    const createdAPIKey = data.enabled
      ? await this.createAPIKey(this.generateAPIKeyName(alertType.id, data.name))
      : null;

    this.validateActions(alertType, data.actions);

    const { references, actions } = await this.denormalizeActions(data.actions);
    const rawAlert: RawAlert = {
      ...data,
      ...this.apiKeyAsAlertAttributes(createdAPIKey, username),
      actions,
      createdBy: username,
      updatedBy: username,
      createdAt: new Date().toISOString(),
      params: validatedAlertTypeParams as RawAlert['params'],
      muteAll: false,
      mutedInstanceIds: [],
    };
    let createdAlert: SavedObject<RawAlert>;
    try {
      createdAlert = await this.unsecuredSavedObjectsClient.create(
        'alert',
        this.updateMeta(rawAlert),
        {
          ...options,
          references,
        }
      );
    } catch (e) {
      // Avoid unused API key
      this.invalidateApiKey({ apiKey: rawAlert.apiKey });
      throw e;
    }
    if (data.enabled) {
      let scheduledTask;
      try {
        scheduledTask = await this.scheduleAlert(createdAlert.id, rawAlert.alertTypeId);
      } catch (e) {
        // Cleanup data, something went wrong scheduling the task
        try {
          await this.unsecuredSavedObjectsClient.delete('alert', createdAlert.id);
        } catch (err) {
          // Skip the cleanup error and throw the task manager error to avoid confusion
          this.logger.error(
            `Failed to cleanup alert "${createdAlert.id}" after scheduling task failed. Error: ${err.message}`
          );
        }
        throw e;
      }
      await this.unsecuredSavedObjectsClient.update<RawAlert>('alert', createdAlert.id, {
        scheduledTaskId: scheduledTask.id,
      });
      createdAlert.attributes.scheduledTaskId = scheduledTask.id;
    }
    return this.getAlertFromRaw(
      createdAlert.id,
      createdAlert.attributes,
      createdAlert.updated_at,
      references
    );
  }

  public async get({ id }: { id: string }): Promise<SanitizedAlert> {
    const result = await this.unsecuredSavedObjectsClient.get<RawAlert>('alert', id);
    await this.authorization.ensureAuthorized(
      result.attributes.alertTypeId,
      result.attributes.consumer,
      ReadOperations.Get
    );
    return this.getAlertFromRaw(result.id, result.attributes, result.updated_at, result.references);
  }

  public async getAlertState({ id }: { id: string }): Promise<AlertTaskState | void> {
    const alert = await this.get({ id });
    await this.authorization.ensureAuthorized(
      alert.alertTypeId,
      alert.consumer,
      ReadOperations.GetAlertState
    );
    if (alert.scheduledTaskId) {
      const { state } = taskInstanceToAlertTaskInstance(
        await this.taskManager.get(alert.scheduledTaskId),
        alert
      );
      return state;
    }
  }

  public async getAlertInstanceSummary({
    id,
    dateStart,
  }: GetAlertInstanceSummaryParams): Promise<AlertInstanceSummary> {
    this.logger.debug(`getAlertInstanceSummary(): getting alert ${id}`);
    const alert = await this.get({ id });
    await this.authorization.ensureAuthorized(
      alert.alertTypeId,
      alert.consumer,
      ReadOperations.GetAlertInstanceSummary
    );

    // default duration of instance summary is 60 * alert interval
    const dateNow = new Date();
    const durationMillis = parseDuration(alert.schedule.interval) * 60;
    const defaultDateStart = new Date(dateNow.valueOf() - durationMillis);
    const parsedDateStart = parseDate(dateStart, 'dateStart', defaultDateStart);

    const eventLogClient = await this.getEventLogClient();

    this.logger.debug(`getAlertInstanceSummary(): search the event log for alert ${id}`);
    let events: IEvent[];
    try {
      const queryResults = await eventLogClient.findEventsBySavedObject('alert', id, {
        page: 1,
        per_page: 10000,
        start: parsedDateStart.toISOString(),
        end: dateNow.toISOString(),
        sort_order: 'desc',
      });
      events = queryResults.data;
    } catch (err) {
      this.logger.debug(
        `alertsClient.getAlertInstanceSummary(): error searching event log for alert ${id}: ${err.message}`
      );
      events = [];
    }

    return alertInstanceSummaryFromEventLog({
      alert,
      events,
      dateStart: parsedDateStart.toISOString(),
      dateEnd: dateNow.toISOString(),
    });
  }

  public async find({
    options: { fields, ...options } = {},
  }: { options?: FindOptions } = {}): Promise<FindResult> {
    const {
      filter: authorizationFilter,
      ensureAlertTypeIsAuthorized,
      logSuccessfulAuthorization,
    } = await this.authorization.getFindAuthorizationFilter();

    const {
      page,
      per_page: perPage,
      total,
      saved_objects: data,
    } = await this.unsecuredSavedObjectsClient.find<RawAlert>({
      ...options,
      filter:
        (authorizationFilter && options.filter
          ? and([esKuery.fromKueryExpression(options.filter), authorizationFilter])
          : authorizationFilter) ?? options.filter,
      fields: fields ? this.includeFieldsRequiredForAuthentication(fields) : fields,
      type: 'alert',
    });

    // eslint-disable-next-line @typescript-eslint/naming-convention
    const authorizedData = data.map(({ id, attributes, updated_at, references }) => {
      ensureAlertTypeIsAuthorized(attributes.alertTypeId, attributes.consumer);
      return this.getAlertFromRaw(
        id,
        fields ? (pick(attributes, fields) as RawAlert) : attributes,
        updated_at,
        references
      );
    });

    logSuccessfulAuthorization();

    return {
      page,
      perPage,
      total,
      data: authorizedData,
    };
  }

  public async delete({ id }: { id: string }) {
    let taskIdToRemove: string | undefined | null;
    let apiKeyToInvalidate: string | null = null;
    let attributes: RawAlert;

    try {
      const decryptedAlert = await this.encryptedSavedObjectsClient.getDecryptedAsInternalUser<
        RawAlert
      >('alert', id, { namespace: this.namespace });
      apiKeyToInvalidate = decryptedAlert.attributes.apiKey;
      taskIdToRemove = decryptedAlert.attributes.scheduledTaskId;
      attributes = decryptedAlert.attributes;
    } catch (e) {
      // We'll skip invalidating the API key since we failed to load the decrypted saved object
      this.logger.error(
        `delete(): Failed to load API key to invalidate on alert ${id}: ${e.message}`
      );
      // Still attempt to load the scheduledTaskId using SOC
      const alert = await this.unsecuredSavedObjectsClient.get<RawAlert>('alert', id);
      taskIdToRemove = alert.attributes.scheduledTaskId;
      attributes = alert.attributes;
    }

    await this.authorization.ensureAuthorized(
      attributes.alertTypeId,
      attributes.consumer,
      WriteOperations.Delete
    );

    const removeResult = await this.unsecuredSavedObjectsClient.delete('alert', id);

    await Promise.all([
      taskIdToRemove ? deleteTaskIfItExists(this.taskManager, taskIdToRemove) : null,
      apiKeyToInvalidate ? this.invalidateApiKey({ apiKey: apiKeyToInvalidate }) : null,
    ]);

    return removeResult;
  }

  public async update({ id, data }: UpdateOptions): Promise<PartialAlert> {
    return await retryIfConflicts(
      this.logger,
      `alertsClient.update('${id}')`,
      async () => await this.updateWithOCC({ id, data })
    );
  }

  private async updateWithOCC({ id, data }: UpdateOptions): Promise<PartialAlert> {
    let alertSavedObject: SavedObject<RawAlert>;

    try {
      alertSavedObject = await this.encryptedSavedObjectsClient.getDecryptedAsInternalUser<
        RawAlert
      >('alert', id, { namespace: this.namespace });
    } catch (e) {
      // We'll skip invalidating the API key since we failed to load the decrypted saved object
      this.logger.error(
        `update(): Failed to load API key to invalidate on alert ${id}: ${e.message}`
      );
      // Still attempt to load the object using SOC
      alertSavedObject = await this.unsecuredSavedObjectsClient.get<RawAlert>('alert', id);
    }
    await this.authorization.ensureAuthorized(
      alertSavedObject.attributes.alertTypeId,
      alertSavedObject.attributes.consumer,
      WriteOperations.Update
    );

    const updateResult = await this.updateAlert({ id, data }, alertSavedObject);

    await Promise.all([
      alertSavedObject.attributes.apiKey
        ? this.invalidateApiKey({ apiKey: alertSavedObject.attributes.apiKey })
        : null,
      (async () => {
        if (
          updateResult.scheduledTaskId &&
          !isEqual(alertSavedObject.attributes.schedule, updateResult.schedule)
        ) {
          this.taskManager
            .runNow(updateResult.scheduledTaskId)
            .then(() => {
              this.logger.debug(
                `Alert update has rescheduled the underlying task: ${updateResult.scheduledTaskId}`
              );
            })
            .catch((err: Error) => {
              this.logger.error(
                `Alert update failed to run its underlying task. TaskManager runNow failed with Error: ${err.message}`
              );
            });
        }
      })(),
    ]);

    return updateResult;
  }

  private async updateAlert(
    { id, data }: UpdateOptions,
    { attributes, version }: SavedObject<RawAlert>
  ): Promise<PartialAlert> {
    const alertType = this.alertTypeRegistry.get(attributes.alertTypeId);

    // Validate
    const validatedAlertTypeParams = validateAlertTypeParams(alertType, data.params);
    this.validateActions(alertType, data.actions);

    const { actions, references } = await this.denormalizeActions(data.actions);
    const username = await this.getUserName();
    const createdAPIKey = attributes.enabled
      ? await this.createAPIKey(this.generateAPIKeyName(alertType.id, data.name))
      : null;
    const apiKeyAttributes = this.apiKeyAsAlertAttributes(createdAPIKey, username);

    let updatedObject: SavedObject<RawAlert>;
    const createAttributes = this.updateMeta({
      ...attributes,
      ...data,
      ...apiKeyAttributes,
      params: validatedAlertTypeParams as RawAlert['params'],
      actions,
      updatedBy: username,
    });
    try {
      updatedObject = await this.unsecuredSavedObjectsClient.create<RawAlert>(
        'alert',
        createAttributes,
        {
          id,
          overwrite: true,
          version,
          references,
        }
      );
    } catch (e) {
      // Avoid unused API key
      this.invalidateApiKey({ apiKey: createAttributes.apiKey });
      throw e;
    }

    return this.getPartialAlertFromRaw(
      id,
      updatedObject.attributes,
      updatedObject.updated_at,
      updatedObject.references
    );
  }

  private apiKeyAsAlertAttributes(
    apiKey: CreateAPIKeyResult | null,
    username: string | null
  ): Pick<RawAlert, 'apiKey' | 'apiKeyOwner'> {
    return apiKey && apiKey.apiKeysEnabled
      ? {
          apiKeyOwner: username,
          apiKey: Buffer.from(`${apiKey.result.id}:${apiKey.result.api_key}`).toString('base64'),
        }
      : {
          apiKeyOwner: null,
          apiKey: null,
        };
  }

  public async updateApiKey({ id }: { id: string }): Promise<void> {
    return await retryIfConflicts(
      this.logger,
      `alertsClient.updateApiKey('${id}')`,
      async () => await this.updateApiKeyWithOCC({ id })
    );
  }

  private async updateApiKeyWithOCC({ id }: { id: string }) {
    let apiKeyToInvalidate: string | null = null;
    let attributes: RawAlert;
    let version: string | undefined;

    try {
      const decryptedAlert = await this.encryptedSavedObjectsClient.getDecryptedAsInternalUser<
        RawAlert
      >('alert', id, { namespace: this.namespace });
      apiKeyToInvalidate = decryptedAlert.attributes.apiKey;
      attributes = decryptedAlert.attributes;
      version = decryptedAlert.version;
    } catch (e) {
      // We'll skip invalidating the API key since we failed to load the decrypted saved object
      this.logger.error(
        `updateApiKey(): Failed to load API key to invalidate on alert ${id}: ${e.message}`
      );
      // Still attempt to load the attributes and version using SOC
      const alert = await this.unsecuredSavedObjectsClient.get<RawAlert>('alert', id);
      attributes = alert.attributes;
      version = alert.version;
    }
    await this.authorization.ensureAuthorized(
      attributes.alertTypeId,
      attributes.consumer,
      WriteOperations.UpdateApiKey
    );

    if (attributes.actions.length && !this.authorization.shouldUseLegacyAuthorization(attributes)) {
      await this.actionsAuthorization.ensureAuthorized('execute');
    }

    const username = await this.getUserName();
    const updateAttributes = this.updateMeta({
      ...attributes,
      ...this.apiKeyAsAlertAttributes(
        await this.createAPIKey(this.generateAPIKeyName(attributes.alertTypeId, attributes.name)),
        username
      ),
      updatedBy: username,
    });
    try {
      await this.unsecuredSavedObjectsClient.update('alert', id, updateAttributes, { version });
    } catch (e) {
      // Avoid unused API key
      this.invalidateApiKey({ apiKey: updateAttributes.apiKey });
      throw e;
    }

    if (apiKeyToInvalidate) {
      await this.invalidateApiKey({ apiKey: apiKeyToInvalidate });
    }
  }

  private async invalidateApiKey({ apiKey }: { apiKey: string | null }): Promise<void> {
    if (!apiKey) {
      return;
    }

    try {
      const apiKeyId = Buffer.from(apiKey, 'base64').toString().split(':')[0];
      const response = await this.invalidateAPIKey({ id: apiKeyId });
      if (response.apiKeysEnabled === true && response.result.error_count > 0) {
        this.logger.error(`Failed to invalidate API Key [id="${apiKeyId}"]`);
      }
    } catch (e) {
      this.logger.error(`Failed to invalidate API Key: ${e.message}`);
    }
  }

  public async enable({ id }: { id: string }): Promise<void> {
    return await retryIfConflicts(
      this.logger,
      `alertsClient.enable('${id}')`,
      async () => await this.enableWithOCC({ id })
    );
  }

  private async enableWithOCC({ id }: { id: string }) {
    let apiKeyToInvalidate: string | null = null;
    let attributes: RawAlert;
    let version: string | undefined;

    try {
      const decryptedAlert = await this.encryptedSavedObjectsClient.getDecryptedAsInternalUser<
        RawAlert
      >('alert', id, { namespace: this.namespace });
      apiKeyToInvalidate = decryptedAlert.attributes.apiKey;
      attributes = decryptedAlert.attributes;
      version = decryptedAlert.version;
    } catch (e) {
      // We'll skip invalidating the API key since we failed to load the decrypted saved object
      this.logger.error(
        `enable(): Failed to load API key to invalidate on alert ${id}: ${e.message}`
      );
      // Still attempt to load the attributes and version using SOC
      const alert = await this.unsecuredSavedObjectsClient.get<RawAlert>('alert', id);
      attributes = alert.attributes;
      version = alert.version;
    }

    await this.authorization.ensureAuthorized(
      attributes.alertTypeId,
      attributes.consumer,
      WriteOperations.Enable
    );

    if (attributes.actions.length) {
      await this.actionsAuthorization.ensureAuthorized('execute');
    }

    if (attributes.enabled === false) {
      const username = await this.getUserName();
      const updateAttributes = this.updateMeta({
        ...attributes,
        enabled: true,
        ...this.apiKeyAsAlertAttributes(
          await this.createAPIKey(this.generateAPIKeyName(attributes.alertTypeId, attributes.name)),
          username
        ),
        updatedBy: username,
      });
      try {
        await this.unsecuredSavedObjectsClient.update('alert', id, updateAttributes, { version });
      } catch (e) {
        // Avoid unused API key
        this.invalidateApiKey({ apiKey: updateAttributes.apiKey });
        throw e;
      }
      const scheduledTask = await this.scheduleAlert(id, attributes.alertTypeId);
      await this.unsecuredSavedObjectsClient.update('alert', id, {
        scheduledTaskId: scheduledTask.id,
      });
      if (apiKeyToInvalidate) {
        await this.invalidateApiKey({ apiKey: apiKeyToInvalidate });
      }
    }
  }

  public async disable({ id }: { id: string }): Promise<void> {
    return await retryIfConflicts(
      this.logger,
      `alertsClient.disable('${id}')`,
      async () => await this.disableWithOCC({ id })
    );
  }

  private async disableWithOCC({ id }: { id: string }) {
    let apiKeyToInvalidate: string | null = null;
    let attributes: RawAlert;
    let version: string | undefined;

    try {
      const decryptedAlert = await this.encryptedSavedObjectsClient.getDecryptedAsInternalUser<
        RawAlert
      >('alert', id, { namespace: this.namespace });
      apiKeyToInvalidate = decryptedAlert.attributes.apiKey;
      attributes = decryptedAlert.attributes;
      version = decryptedAlert.version;
    } catch (e) {
      // We'll skip invalidating the API key since we failed to load the decrypted saved object
      this.logger.error(
        `disable(): Failed to load API key to invalidate on alert ${id}: ${e.message}`
      );
      // Still attempt to load the attributes and version using SOC
      const alert = await this.unsecuredSavedObjectsClient.get<RawAlert>('alert', id);
      attributes = alert.attributes;
      version = alert.version;
    }

    await this.authorization.ensureAuthorized(
      attributes.alertTypeId,
      attributes.consumer,
      WriteOperations.Disable
    );

    if (attributes.enabled === true) {
      await this.unsecuredSavedObjectsClient.update(
        'alert',
        id,
        this.updateMeta({
          ...attributes,
          enabled: false,
          scheduledTaskId: null,
          apiKey: null,
          apiKeyOwner: null,
          updatedBy: await this.getUserName(),
        }),
        { version }
      );

      await Promise.all([
        attributes.scheduledTaskId
          ? deleteTaskIfItExists(this.taskManager, attributes.scheduledTaskId)
          : null,
        apiKeyToInvalidate ? this.invalidateApiKey({ apiKey: apiKeyToInvalidate }) : null,
      ]);
    }
  }

  public async muteAll({ id }: { id: string }): Promise<void> {
    return await retryIfConflicts(
      this.logger,
      `alertsClient.muteAll('${id}')`,
      async () => await this.muteAllWithOCC({ id })
    );
  }

  private async muteAllWithOCC({ id }: { id: string }) {
    const { attributes, version } = await this.unsecuredSavedObjectsClient.get<RawAlert>(
      'alert',
      id
    );
    await this.authorization.ensureAuthorized(
      attributes.alertTypeId,
      attributes.consumer,
      WriteOperations.MuteAll
    );

    if (attributes.actions.length) {
      await this.actionsAuthorization.ensureAuthorized('execute');
    }

    const updateAttributes = this.updateMeta({
      muteAll: true,
      mutedInstanceIds: [],
      updatedBy: await this.getUserName(),
    });
    const updateOptions = { version };

    await partiallyUpdateAlert(
      this.unsecuredSavedObjectsClient,
      id,
      updateAttributes,
      updateOptions
    );
  }

  public async unmuteAll({ id }: { id: string }): Promise<void> {
    return await retryIfConflicts(
      this.logger,
      `alertsClient.unmuteAll('${id}')`,
      async () => await this.unmuteAllWithOCC({ id })
    );
  }

  private async unmuteAllWithOCC({ id }: { id: string }) {
    const { attributes, version } = await this.unsecuredSavedObjectsClient.get<RawAlert>(
      'alert',
      id
    );
    await this.authorization.ensureAuthorized(
      attributes.alertTypeId,
      attributes.consumer,
      WriteOperations.UnmuteAll
    );

    if (attributes.actions.length) {
      await this.actionsAuthorization.ensureAuthorized('execute');
    }

    const updateAttributes = this.updateMeta({
      muteAll: false,
      mutedInstanceIds: [],
      updatedBy: await this.getUserName(),
    });
    const updateOptions = { version };

    await partiallyUpdateAlert(
      this.unsecuredSavedObjectsClient,
      id,
      updateAttributes,
      updateOptions
    );
  }

  public async muteInstance({ alertId, alertInstanceId }: MuteOptions): Promise<void> {
    return await retryIfConflicts(
      this.logger,
      `alertsClient.muteInstance('${alertId}')`,
      async () => await this.muteInstanceWithOCC({ alertId, alertInstanceId })
    );
  }

  private async muteInstanceWithOCC({ alertId, alertInstanceId }: MuteOptions) {
    const { attributes, version } = await this.unsecuredSavedObjectsClient.get<Alert>(
      'alert',
      alertId
    );

    await this.authorization.ensureAuthorized(
      attributes.alertTypeId,
      attributes.consumer,
      WriteOperations.MuteInstance
    );

    if (attributes.actions.length) {
      await this.actionsAuthorization.ensureAuthorized('execute');
    }

    const mutedInstanceIds = attributes.mutedInstanceIds || [];
    if (!attributes.muteAll && !mutedInstanceIds.includes(alertInstanceId)) {
      mutedInstanceIds.push(alertInstanceId);
      await this.unsecuredSavedObjectsClient.update(
        'alert',
        alertId,
        this.updateMeta({
          mutedInstanceIds,
          updatedBy: await this.getUserName(),
        }),
        { version }
      );
    }
  }

  public async unmuteInstance({ alertId, alertInstanceId }: MuteOptions): Promise<void> {
    return await retryIfConflicts(
      this.logger,
      `alertsClient.unmuteInstance('${alertId}')`,
      async () => await this.unmuteInstanceWithOCC({ alertId, alertInstanceId })
    );
  }

  private async unmuteInstanceWithOCC({
    alertId,
    alertInstanceId,
  }: {
    alertId: string;
    alertInstanceId: string;
  }) {
    const { attributes, version } = await this.unsecuredSavedObjectsClient.get<Alert>(
      'alert',
      alertId
    );

    await this.authorization.ensureAuthorized(
      attributes.alertTypeId,
      attributes.consumer,
      WriteOperations.UnmuteInstance
    );
    if (attributes.actions.length) {
      await this.actionsAuthorization.ensureAuthorized('execute');
    }

    const mutedInstanceIds = attributes.mutedInstanceIds || [];
    if (!attributes.muteAll && mutedInstanceIds.includes(alertInstanceId)) {
      await this.unsecuredSavedObjectsClient.update<RawAlert>(
        'alert',
        alertId,
        this.updateMeta({
          updatedBy: await this.getUserName(),
          mutedInstanceIds: mutedInstanceIds.filter((id: string) => id !== alertInstanceId),
        }),
        { version }
      );
    }
  }

  public async listAlertTypes() {
    return await this.authorization.filterByAlertTypeAuthorization(this.alertTypeRegistry.list(), [
      ReadOperations.Get,
      WriteOperations.Create,
    ]);
  }

  private async scheduleAlert(id: string, alertTypeId: string) {
    return await this.taskManager.schedule({
      taskType: `alerting:${alertTypeId}`,
      params: {
        alertId: id,
        spaceId: this.spaceId,
      },
      state: {
        previousStartedAt: null,
        alertTypeState: {},
        alertInstances: {},
      },
      scope: ['alerting'],
    });
  }

  private injectReferencesIntoActions(
    alertId: string,
    actions: RawAlert['actions'],
    references: SavedObjectReference[]
  ) {
    return actions.map((action) => {
      const reference = references.find((ref) => ref.name === action.actionRef);
      if (!reference) {
        throw new Error(`Action reference "${action.actionRef}" not found in alert id: ${alertId}`);
      }
      return {
        ...omit(action, 'actionRef'),
        id: reference.id,
      };
    }) as Alert['actions'];
  }

  private getAlertFromRaw(
    id: string,
    rawAlert: RawAlert,
    updatedAt: SavedObject['updated_at'],
    references: SavedObjectReference[] | undefined
  ): Alert {
    // In order to support the partial update API of Saved Objects we have to support
    // partial updates of an Alert, but when we receive an actual RawAlert, it is safe
    // to cast the result to an Alert
    return this.getPartialAlertFromRaw(id, rawAlert, updatedAt, references) as Alert;
  }

  private getPartialAlertFromRaw(
    id: string,
    { createdAt, meta, scheduledTaskId, ...rawAlert }: Partial<RawAlert>,
    updatedAt: SavedObject['updated_at'] = createdAt,
    references: SavedObjectReference[] | undefined
  ): PartialAlert {
    return {
      id,
      ...rawAlert,
      // we currently only support the Interval Schedule type
      // Once we support additional types, this type signature will likely change
      schedule: rawAlert.schedule as IntervalSchedule,
      actions: rawAlert.actions
        ? this.injectReferencesIntoActions(id, rawAlert.actions, references || [])
        : [],
      ...(updatedAt ? { updatedAt: new Date(updatedAt) } : {}),
      ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
      ...(scheduledTaskId ? { scheduledTaskId } : {}),
    };
  }

  private validateActions(alertType: AlertType, actions: NormalizedAlertAction[]): void {
    const { actionGroups: alertTypeActionGroups } = alertType;
    const usedAlertActionGroups = actions.map((action) => action.group);
    const availableAlertTypeActionGroups = new Set(map(alertTypeActionGroups, 'id'));
    const invalidActionGroups = usedAlertActionGroups.filter(
      (group) => !availableAlertTypeActionGroups.has(group)
    );
    if (invalidActionGroups.length) {
      throw Boom.badRequest(
        i18n.translate('xpack.alerts.alertsClient.validateActions.invalidGroups', {
          defaultMessage: 'Invalid action groups: {groups}',
          values: {
            groups: invalidActionGroups.join(', '),
          },
        })
      );
    }
  }

  private async denormalizeActions(
    alertActions: NormalizedAlertAction[]
  ): Promise<{ actions: RawAlert['actions']; references: SavedObjectReference[] }> {
    const references: SavedObjectReference[] = [];
    const actions: RawAlert['actions'] = [];
    if (alertActions.length) {
      const actionsClient = await this.getActionsClient();
      const actionIds = [...new Set(alertActions.map((alertAction) => alertAction.id))];
      const actionResults = await actionsClient.getBulk(actionIds);
      alertActions.forEach(({ id, ...alertAction }, i) => {
        const actionResultValue = actionResults.find((action) => action.id === id);
        if (actionResultValue) {
          const actionRef = `action_${i}`;
          references.push({
            id,
            name: actionRef,
            type: 'action',
          });
          actions.push({
            ...alertAction,
            actionRef,
            actionTypeId: actionResultValue.actionTypeId,
          });
        } else {
          actions.push({
            ...alertAction,
            actionRef: '',
            actionTypeId: '',
          });
        }
      });
    }
    return {
      actions,
      references,
    };
  }

  private includeFieldsRequiredForAuthentication(fields: string[]): string[] {
    return uniq([...fields, 'alertTypeId', 'consumer']);
  }

  private generateAPIKeyName(alertTypeId: string, alertName: string) {
    return truncate(`Alerting: ${alertTypeId}/${trim(alertName)}`, { length: 256 });
  }

  private updateMeta<T extends Partial<RawAlert>>(alertAttributes: T): T {
    if (alertAttributes.hasOwnProperty('apiKey') || alertAttributes.hasOwnProperty('apiKeyOwner')) {
      alertAttributes.meta = alertAttributes.meta ?? {};
      alertAttributes.meta.versionApiKeyLastmodified = this.kibanaVersion;
    }
    return alertAttributes;
  }
}

function parseDate(dateString: string | undefined, propertyName: string, defaultValue: Date): Date {
  if (dateString === undefined) {
    return defaultValue;
  }

  const parsedDate = parseIsoOrRelativeDate(dateString);
  if (parsedDate === undefined) {
    throw Boom.badRequest(
      i18n.translate('xpack.alerts.alertsClient.invalidDate', {
        defaultMessage: 'Invalid date for parameter {field}: "{dateValue}"',
        values: {
          field: propertyName,
          dateValue: dateString,
        },
      })
    );
  }

  return parsedDate;
}
