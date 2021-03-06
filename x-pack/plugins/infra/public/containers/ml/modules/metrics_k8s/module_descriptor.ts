/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { i18n } from '@kbn/i18n';
import { ModuleDescriptor, ModuleSourceConfiguration } from '../../infra_ml_module_types';
import { cleanUpJobsAndDatafeeds } from '../../infra_ml_cleanup';
import { callJobsSummaryAPI } from '../../api/ml_get_jobs_summary_api';
import { callGetMlModuleAPI } from '../../api/ml_get_module';
import { callSetupMlModuleAPI } from '../../api/ml_setup_module_api';
import {
  metricsK8SJobTypes,
  getJobId,
  MetricK8sJobType,
  DatasetFilter,
  bucketSpan,
} from '../../../../../common/infra_ml';
// eslint-disable-next-line @kbn/eslint/no-restricted-paths
import MemoryJob from '../../../../../../ml/server/models/data_recognizer/modules/metrics_ui_k8s/ml/k8s_memory_usage.json';
// eslint-disable-next-line @kbn/eslint/no-restricted-paths
import MemoryDatafeed from '../../../../../../ml/server/models/data_recognizer/modules/metrics_ui_k8s/ml/datafeed_k8s_memory_usage.json';
// eslint-disable-next-line @kbn/eslint/no-restricted-paths
import NetworkInJob from '../../../../../../ml/server/models/data_recognizer/modules/metrics_ui_k8s/ml/k8s_network_in.json';
// eslint-disable-next-line @kbn/eslint/no-restricted-paths
import NetworkInDatafeed from '../../../../../../ml/server/models/data_recognizer/modules/metrics_ui_k8s/ml/datafeed_k8s_network_in.json';
// eslint-disable-next-line @kbn/eslint/no-restricted-paths
import NetworkOutJob from '../../../../../../ml/server/models/data_recognizer/modules/metrics_ui_k8s/ml/k8s_network_out.json';
// eslint-disable-next-line @kbn/eslint/no-restricted-paths
import NetworkOutDatafeed from '../../../../../../ml/server/models/data_recognizer/modules/metrics_ui_k8s/ml/datafeed_k8s_network_out.json';

type JobType = 'k8s_memory_usage' | 'k8s_network_in' | 'k8s_network_out';
export const DEFAULT_K8S_PARTITION_FIELD = 'kubernetes.namespace';
const moduleId = 'metrics_ui_k8s';
const moduleName = i18n.translate('xpack.infra.ml.metricsModuleName', {
  defaultMessage: 'Metrics anomanly detection',
});
const moduleDescription = i18n.translate('xpack.infra.ml.metricsHostModuleDescription', {
  defaultMessage: 'Use Machine Learning to automatically detect anomalous log entry rates.',
});

const getJobIds = (spaceId: string, sourceId: string) =>
  metricsK8SJobTypes.reduce(
    (accumulatedJobIds, jobType) => ({
      ...accumulatedJobIds,
      [jobType]: getJobId(spaceId, sourceId, jobType),
    }),
    {} as Record<MetricK8sJobType, string>
  );

const getJobSummary = async (spaceId: string, sourceId: string) => {
  const response = await callJobsSummaryAPI(spaceId, sourceId, metricsK8SJobTypes);
  const jobIds = Object.values(getJobIds(spaceId, sourceId));

  return response.filter((jobSummary) => jobIds.includes(jobSummary.id));
};

const getModuleDefinition = async () => {
  return await callGetMlModuleAPI(moduleId);
};

const setUpModule = async (
  start: number | undefined,
  end: number | undefined,
  datasetFilter: DatasetFilter,
  { spaceId, sourceId, indices, timestampField }: ModuleSourceConfiguration,
  partitionField?: string
) => {
  const indexNamePattern = indices.join(',');
  const jobIds: JobType[] = ['k8s_memory_usage', 'k8s_network_in', 'k8s_network_out'];
  const jobOverrides = jobIds.map((id) => {
    const { job: defaultJobConfig } = getDefaultJobConfigs(id);

    // eslint-disable-next-line @typescript-eslint/naming-convention
    const analysis_config = {
      ...defaultJobConfig.analysis_config,
    };

    if (partitionField) {
      analysis_config.detectors[0].partition_field_name = partitionField;
      if (analysis_config.influencers.indexOf(partitionField) === -1) {
        analysis_config.influencers.push(partitionField);
      }
    }

    return {
      job_id: id,
      data_description: {
        time_field: timestampField,
      },
      analysis_config,
      custom_settings: {
        metrics_source_config: {
          indexPattern: indexNamePattern,
          timestampField,
          bucketSpan,
        },
      },
    };
  });

  const datafeedOverrides = jobIds.map((id) => {
    const { datafeed: defaultDatafeedConfig } = getDefaultJobConfigs(id);

    if (!partitionField || id === 'k8s_memory_usage') {
      // Since the host memory usage doesn't have custom aggs, we don't need to do anything to add a partition field
      return defaultDatafeedConfig;
    }

    // Because the ML K8s jobs ship with a default partition field of {kubernetes.namespace}, ignore that agg and wrap it in our own agg.
    const innerAggregation =
      defaultDatafeedConfig.aggregations[DEFAULT_K8S_PARTITION_FIELD].aggregations;

    // If we have a partition field, we need to change the aggregation to do a terms agg to partition the data at the top level
    const aggregations = {
      [partitionField]: {
        terms: {
          field: partitionField,
          size: 25, // 25 is arbitratry and only used to keep the number of buckets to a managable level in the event that the user choose a high cardinality partition field.
        },
        aggregations: {
          ...innerAggregation,
        },
      },
    };

    return {
      ...defaultDatafeedConfig,
      job_id: id,
      aggregations,
    };
  });

  return callSetupMlModuleAPI(
    moduleId,
    start,
    end,
    spaceId,
    sourceId,
    indexNamePattern,
    jobOverrides,
    datafeedOverrides
  );
};

const getDefaultJobConfigs = (jobId: JobType) => {
  switch (jobId) {
    case 'k8s_memory_usage':
      return {
        datafeed: MemoryDatafeed,
        job: MemoryJob,
      };
    case 'k8s_network_in':
      return {
        datafeed: NetworkInDatafeed,
        job: NetworkInJob,
      };
    case 'k8s_network_out':
      return {
        datafeed: NetworkOutDatafeed,
        job: NetworkOutJob,
      };
  }
};

const cleanUpModule = async (spaceId: string, sourceId: string) => {
  return await cleanUpJobsAndDatafeeds(spaceId, sourceId, metricsK8SJobTypes);
};

export const metricHostsModule: ModuleDescriptor<MetricK8sJobType> = {
  moduleId,
  moduleName,
  moduleDescription,
  jobTypes: metricsK8SJobTypes,
  bucketSpan,
  getJobIds,
  getJobSummary,
  getModuleDefinition,
  setUpModule,
  cleanUpModule,
};
