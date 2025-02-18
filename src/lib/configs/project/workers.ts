/**
 * Copyright 2023 Fluence Labs Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { join } from "path";

import type { JSONSchemaType } from "ajv";
import isEmpty from "lodash-es/isEmpty.js";

import { ajv, validationErrorToString } from "../../ajvInstance.js";
import {
  WORKERS_CONFIG_FULL_FILE_NAME,
  TOP_LEVEL_SCHEMA_ID,
  WORKERS_CONFIG_FILE_NAME,
  CLI_NAME,
  type ChainENV,
  CHAIN_ENV,
  DEFAULT_DEPLOYMENT_NAME,
  DEFAULT_WORKER_NAME,
  type FluenceEnv,
  FLUENCE_ENVS,
  DEFAULT_PUBLIC_FLUENCE_ENV,
} from "../../const.js";
import { getFluenceDir } from "../../paths.js";
import { fluenceEnvPrompt } from "../../resolveFluenceEnv.js";
import {
  getReadonlyConfigInitFunction,
  getConfigInitFunction,
  type InitConfigOptions,
  type InitializedConfig,
  type InitializedReadonlyConfig,
  type Migrations,
  type GetDefaultConfig,
} from "../initConfig.js";

type WorkerInfo = {
  timestamp: string;
  definition: string;
};

const workerInfoSchema = {
  type: "object",
  properties: {
    definition: {
      type: "string",
      description:
        "CID of uploaded to IPFS App Definition, which contains the data about everything that you are trying to deploy, including spells, service and module configs and CIDs for service wasms",
    },
    timestamp: {
      type: "string",
      description: "ISO timestamp of the time when the worker was deployed",
    },
  },
  required: ["timestamp", "definition"],
  additionalProperties: false,
} as const satisfies JSONSchemaType<WorkerInfo>;

export type Deal = WorkerInfo & {
  dealId: string;
  dealIdOriginal: string;
  chainNetworkId: number;
  chainNetwork?: ChainENV;
};

export type Host = WorkerInfo & {
  relayId: string;
  dummyDealId: string;
  installation_spells: {
    host_id: string;
    spell_id: string;
    worker_id: string;
  }[];
};

type ConfigV0 = {
  version: 0;
  deals?: Record<string, Deal>;
  hosts?: Record<string, Host>;
};

const hostSchema: JSONSchemaType<Host> = {
  ...workerInfoSchema,
  description:
    "Contains data related to your direct deployment. Most importantly, it contains ids in installation_spells property that can be used to resolve workers in aqua",
  properties: {
    ...workerInfoSchema.properties,
    dummyDealId: {
      type: "string",
      description:
        "random string generated by CLI, used in Nox. You can get worker id from it",
    },
    installation_spells: {
      type: "array",
      description: "A list of installation spells",
      items: {
        type: "object",
        properties: {
          host_id: {
            type: "string",
            description:
              "Can be used to access worker in aqua: `on s.workerId via s.hostId`",
          },
          spell_id: {
            type: "string",
            description:
              "id of the installation spell, can be used to e.g. print spell logs",
          },
          worker_id: {
            type: "string",
            description:
              "Can be used to access worker in aqua: `on s.workerId via s.hostId`",
          },
        },
        required: ["host_id", "spell_id", "worker_id"],
        additionalProperties: false,
      },
    },
    relayId: {
      type: "string",
      description: "relay peer id that was used when deploying",
    },
  },
  required: [
    ...workerInfoSchema.required,
    "installation_spells",
    "relayId",
    "dummyDealId",
  ],
} as const;

const dealSchema: JSONSchemaType<Deal> = {
  ...workerInfoSchema,
  description:
    "Contains data related to your deployment, including, most importantly, deal id, that can be used to resolve workers in aqua",
  properties: {
    ...workerInfoSchema.properties,
    dealId: {
      type: "string",
      description:
        "Lowercased version of dealIdOriginal without 0x prefix. Currently unused. Was previously used to resolve workers in aqua",
    },
    dealIdOriginal: {
      type: "string",
      description:
        "Blockchain transaction id that you get when deploy workers. Can be used in aqua to get worker and host ids. Check out example in the aqua generated in the default template",
    },
    chainNetwork: {
      type: "string",
      enum: CHAIN_ENV,
      description:
        "DEPRECATED. Blockchain network name that was used when deploying workers",
      nullable: true,
    },
    chainNetworkId: {
      type: "integer",
      description: "Blockchain network id that was used when deploying workers",
    },
  },
  required: [
    ...workerInfoSchema.required,
    "dealId",
    "dealIdOriginal",
    "chainNetworkId",
  ],
} as const;

const mapOfDealsSchema = {
  type: "object",
  description: "A map of created deals",
  additionalProperties: dealSchema,
  properties: {
    Worker_deployed_using_deals: dealSchema,
  },
  required: [],
  nullable: true,
} as const satisfies JSONSchemaType<Record<string, Deal>>;

const mapOfHostsSchema = {
  type: "object",
  description: "A map of directly deployed workers",
  additionalProperties: hostSchema,
  properties: {
    Worker_deployed_using_direct_hosting: hostSchema,
  },
  required: [],
  nullable: true,
} as const satisfies JSONSchemaType<Record<string, Host>>;

const configSchemaV0: JSONSchemaType<ConfigV0> = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "integer", const: 0 },
    deals: mapOfDealsSchema,
    hosts: mapOfHostsSchema,
  },
  required: ["version"],
} as const;

type Deals = Partial<Record<FluenceEnv, Record<string, Deal>>>;
type Hosts = Partial<Record<FluenceEnv, Record<string, Host>>>;

type ConfigV1 = {
  version: 1;
  deals?: Deals;
  hosts?: Hosts;
};

const configSchemaV1: JSONSchemaType<ConfigV1> = {
  $id: `${TOP_LEVEL_SCHEMA_ID}/${WORKERS_CONFIG_FULL_FILE_NAME}`,
  title: WORKERS_CONFIG_FULL_FILE_NAME,
  description: `A result of app deployment. This file is created automatically after successful deployment using \`${CLI_NAME} workers deploy\` command`,
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: {
    version: { type: "integer", const: 1, description: "Config version" },
    deals: {
      type: "object",
      description:
        "Info about deals created when deploying workers that is stored by environment that you deployed to",
      additionalProperties: false,
      nullable: true,
      required: [],
      properties: {
        custom: mapOfDealsSchema,
        dar: mapOfDealsSchema,
        kras: mapOfDealsSchema,
        local: mapOfDealsSchema,
        stage: mapOfDealsSchema,
      },
    },
    hosts: {
      description:
        "Info about directly deployed workers that is stored by environment that you deployed to",
      type: "object",
      additionalProperties: false,
      nullable: true,
      required: [],
      properties: {
        custom: mapOfHostsSchema,
        dar: mapOfHostsSchema,
        kras: mapOfHostsSchema,
        local: mapOfHostsSchema,
        stage: mapOfHostsSchema,
      },
    },
  },
};

const validateConfigSchemaV0 = ajv.compile(configSchemaV0);

const migrations: Migrations<Config> = [
  async (config: Config): Promise<ConfigV1> => {
    if (!validateConfigSchemaV0(config)) {
      throw new Error(
        `Migration error. Errors: ${await validationErrorToString(
          validateConfigSchemaV0.errors,
        )}`,
      );
    }

    const configPath = join(getFluenceDir(), WORKERS_CONFIG_FULL_FILE_NAME);

    const deals: Deals = {};

    for (const [workerName, deal] of Object.entries(config.deals ?? {})) {
      const env = await fluenceEnvPrompt(
        `Select the environment that you used for deploying worker ${workerName} with dealId: ${deal.dealId} at ${configPath}`,
        deal.chainNetwork,
      );

      let dealsForEnv = deals[env];

      if (dealsForEnv === undefined) {
        dealsForEnv = {};
        deals[deal.chainNetwork ?? DEFAULT_PUBLIC_FLUENCE_ENV] = dealsForEnv;
      }

      dealsForEnv[workerName] = deal;
    }

    const hosts: Hosts = {};

    for (const [workerName, host] of Object.entries(config.hosts ?? {})) {
      const env = await fluenceEnvPrompt(
        `Select the environment that you used for deploying worker ${workerName} with dummyDealId: ${host.dummyDealId} at ${configPath}`,
        "custom",
      );

      let hostsForEnv = hosts[env];

      if (hostsForEnv === undefined) {
        hostsForEnv = {};
        hosts[env] = hostsForEnv;
      }

      hostsForEnv[workerName] = host;
    }

    return {
      version: 1,
      ...(isEmpty(deals) ? {} : { deals }),
      ...(isEmpty(hosts) ? {} : { hosts }),
    };
  },
];

type Config = ConfigV0 | ConfigV1;
type LatestConfig = ConfigV1;
export type WorkersConfig = InitializedConfig<LatestConfig>;
export type WorkersConfigReadonly = InitializedReadonlyConfig<LatestConfig>;

const initConfigOptions: InitConfigOptions<Config, LatestConfig> = {
  allSchemas: [configSchemaV0, configSchemaV1],
  latestSchema: configSchemaV1,
  migrations,
  name: WORKERS_CONFIG_FILE_NAME,
  getConfigOrConfigDirPath: getFluenceDir,
};

const getDefault: GetDefaultConfig = () => {
  return `# A result of app deployment.
# This file is updated automatically after successful deployment using \`fluence workers deploy\` command

# config version
version: 0

# deals:
# # A map of created deals
#   ${DEFAULT_PUBLIC_FLUENCE_ENV}:
#     ${DEFAULT_DEPLOYMENT_NAME}:
#       # worker CID
#       definition: bafkreigvy3k4racm6i6vvavtr5mdkllmfi2lfkmdk72gnzwk7zdnhajw4y
#       # ISO timestamp of the time when the worker was deployed
#       timestamp: 2023-07-07T11:23:52.353Z
#       # deal ID used in aqua to resolve workers
#       dealId: 799c4beb18ae084d57a90582c2cb8bb19098139e
#       # original deal ID that you get after signing the contract
#       dealIdOriginal: "0x799C4BEB18Ae084D57a90582c2Cb8Bb19098139E"
#       # network ID that was used when deploying worker
#       chainNetworkId: 1313161555

# hosts:
# # A map of directly deployed workers
#   ${FLUENCE_ENVS[0]}:
#     ${DEFAULT_WORKER_NAME}:
#       # worker CID
#       definition: bafkreicoctafgctpxf7jk4nynpnma4wdxpcecjtspsjmuidmag6enctnqa
#       # worker installation spells
#       # host_id and worker_id can be used to access the worker
#       installation_spells:
#         - host_id: 12D3KooWBM3SdXWqGaawQDGQ6JprtwswEg3FWGvGhmgmMez1vRbR
#           spell_id: 9dbe4003-1232-4a20-9d52-5651c5cf4c5c
#           worker_id: 12D3KooWLBQAdDFXz9vWnmgs6MyMfo25bhUTUEiLPsG94ppYq35w
#       # ISO timestamp of the time when the worker was deployed
#       timestamp: 2023-07-07T11:39:57.610Z
#       # relay that was used when connecting to the network
#       relayId: 12D3KooWPisGn7JhooWhggndz25WM7vQ2JmA121EV8jUDQ5xMovJ
`;
};

export const initNewWorkersConfig = getConfigInitFunction(
  initConfigOptions,
  getDefault,
);

export const initNewWorkersConfigReadonly = getReadonlyConfigInitFunction(
  initConfigOptions,
  getDefault,
);

export const workersSchema: JSONSchemaType<LatestConfig> = configSchemaV1;
