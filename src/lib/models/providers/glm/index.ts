import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import { Model, ModelList, ProviderMetadata } from '../../types';
import BaseEmbedding from '../../base/embedding';
import BaseModelProvider from '../../base/provider';
import BaseLLM from '../../base/llm';
import GlmLLM from './glmLLM';
import OpenAIEmbedding from '../openai/openaiEmbedding';

interface GlmConfig {
  apiKey: string;
  baseURL: string;
}

const DEFAULT_GLM_BASE_URL = 'https://api.z.ai/api/paas/v4';

const defaultChatModels: Model[] = [
  {
    name: 'GLM 4.5 Air',
    key: 'glm-4.5-air',
  },
  {
    name: 'GLM 4.5',
    key: 'glm-4.5',
  },
  {
    name: 'GLM 4.6',
    key: 'glm-4.6',
  },
  {
    name: 'GLM 4.7',
    key: 'glm-4.7',
  },
  {
    name: 'GLM 5',
    key: 'glm-5',
  },
  {
    name: 'GLM 5 Turbo',
    key: 'glm-5-turbo',
  },
  {
    name: 'GLM 5.1',
    key: 'glm-5.1',
  },
  {
    name: 'GLM 5.2',
    key: 'glm-5.2',
  },
];

const defaultEmbeddingModels: Model[] = [
  {
    name: 'Embedding 3',
    key: 'embedding-3',
  },
];

const providerConfigFields: UIConfigField[] = [
  {
    type: 'password',
    name: 'API Key',
    key: 'apiKey',
    description: 'Your Zhipu GLM API key (id.secret format)',
    required: true,
    placeholder: 'GLM API Key',
    env: 'GLM_API_KEY',
    scope: 'server',
  },
  {
    type: 'string',
    name: 'Base URL',
    key: 'baseURL',
    description:
      'Zhipu GLM OpenAI-compatible base URL. International: https://api.z.ai/api/paas/v4 — China: https://open.bigmodel.cn/api/paas/v4',
    required: true,
    placeholder: 'GLM Base URL',
    default: DEFAULT_GLM_BASE_URL,
    env: 'GLM_BASE_URL',
    scope: 'server',
  },
];

class GlmProvider extends BaseModelProvider<GlmConfig> {
  constructor(id: string, name: string, config: GlmConfig) {
    super(id, name, config);
  }

  async getDefaultModels(): Promise<ModelList> {
    return {
      embedding: defaultEmbeddingModels,
      chat: defaultChatModels,
    };
  }

  async getModelList(): Promise<ModelList> {
    const defaultModels = await this.getDefaultModels();
    const configProvider = getConfiguredModelProviderById(this.id)!;

    return {
      embedding: [
        ...defaultModels.embedding,
        ...configProvider.embeddingModels,
      ],
      chat: [...defaultModels.chat, ...configProvider.chatModels],
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    const modelList = await this.getModelList();

    const exists = modelList.chat.find((m) => m.key === key);

    if (!exists) {
      throw new Error('Error Loading GLM Chat Model. Invalid Model Selected');
    }

    return new GlmLLM({
      apiKey: this.config.apiKey,
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
    const modelList = await this.getModelList();
    const exists = modelList.embedding.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading GLM Embedding Model. Invalid Model Selected.',
      );
    }

    return new OpenAIEmbedding({
      apiKey: this.config.apiKey,
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  static parseAndValidate(raw: any): GlmConfig {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid config provided. Expected object');
    if (!raw.apiKey)
      throw new Error('Invalid config provided. API key must be provided');

    const baseURL = raw.baseURL || DEFAULT_GLM_BASE_URL;

    return {
      apiKey: String(raw.apiKey),
      baseURL: String(baseURL),
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'glm',
      name: 'GLM (Zhipu)',
    };
  }
}

export default GlmProvider;
