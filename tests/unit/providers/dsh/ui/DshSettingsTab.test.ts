import * as fs from 'node:fs';

import { createMockEl } from '@test/helpers/MockElement';
import { applyTextInput } from '@test/helpers/settingsControls';

import { getDshProviderSettings } from '@/providers/dsh/settings';
import { dshSettingsTabRenderer } from '@/providers/dsh/ui/DshSettingsTab';

const mockGetHostnameKey = jest.fn(() => 'device:current');
const mockRenderEnvironmentSettingsSection = jest.fn();
const mockCLIResolverReset = jest.fn();
const mockRefreshModelCatalog = jest.fn().mockResolvedValue({ changed: false });
const mockGetServices = jest.fn(() => ({
  cliResolver: { reset: mockCLIResolverReset },
  modelCatalog: { refresh: mockRefreshModelCatalog, markStale: jest.fn() },
}));

jest.mock('node:fs');
jest.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public textComponents: MockTextComponent[] = [];
    public toggleComponents: MockToggleComponent[] = [];

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setName(value: string) {
      this.name = value;
      return this;
    }

    setDesc(value: string) {
      this.desc = value;
      return this;
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    addText(callback: (component: MockTextComponent) => void) {
      const component = createTextComponent();
      this.textComponents.push(component);
      callback(component);
      return this;
    }

    addToggle(callback: (component: MockToggleComponent) => void) {
      const component = createToggleComponent();
      this.toggleComponents.push(component);
      callback(component);
      return this;
    }
  }

  return { Setting: MockSetting };
});
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    canApplyProviderEnablement: jest.fn(() => true),
    applyProviderEnablement: jest.fn((settings: Record<string, any>, providerId: string, enabled: boolean) => {
      settings.providerConfigs[providerId].enabled = enabled;
      return true;
    }),
  },
}));
jest.mock('@/core/providers/ProviderWorkspaceRegistry', () => ({
  ProviderWorkspaceRegistry: {
    requireServices: (_providerId: string) => mockGetServices(),
  },
}));
jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));
interface MockTextComponent {
  inputEl: {
    [key: string]: unknown;
    addClass: jest.Mock;
    toggleClass: jest.Mock;
    value: string;
  };
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  placeholder: string;
  value: string;
  onChange(callback: (value: string) => Promise<void> | void): MockTextComponent;
  setPlaceholder(value: string): MockTextComponent;
  setValue(value: string): MockTextComponent;
}

interface MockToggleComponent {
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  value: boolean;
  onChange(callback: (value: boolean) => Promise<void> | void): MockToggleComponent;
  setValue(value: boolean): MockToggleComponent;
}

interface MockSetting {
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  toggleComponents: MockToggleComponent[];
}

interface MockElement {
  children: MockElement[];
  cls?: string;
  href?: string;
  tag?: string;
  text?: string;
  appendText(value: string): void;
  createDiv(options?: { cls?: string; text?: string }): MockElement;
  createEl(tag: string, options?: { cls?: string; href?: string; text?: string }): MockElement;
  setText(value: string): void;
  toggleClass(cls: string, force: boolean): void;
}

const createdSettings: MockSetting[] = [];

function createTextComponent(): MockTextComponent {
  const component: MockTextComponent = {
    inputEl: {
      ...createMockEl('input'),
      addEventListener: jest.fn(),
      addClass: jest.fn(),
      toggleClass: jest.fn(),
      value: '',
    },
    onChangeCallback: null,
    placeholder: '',
    value: '',
    onChange(callback: (value: string) => Promise<void> | void) {
      component.onChangeCallback = callback;
      return component;
    },
    setPlaceholder(value: string) {
      component.placeholder = value;
      return component;
    },
    setValue(value: string) {
      component.value = value;
      component.inputEl.value = value;
      return component;
    },
  };
  return component;
}

function createToggleComponent(): MockToggleComponent {
  const component: MockToggleComponent = {
    onChangeCallback: null,
    value: false,
    onChange(callback: (value: boolean) => Promise<void> | void) {
      component.onChangeCallback = callback;
      return component;
    },
    setValue(value: boolean) {
      component.value = value;
      return component;
    },
  };
  return component;
}

function createElement(
  tag?: string,
  options?: { cls?: string; href?: string; text?: string },
): MockElement {
  const element: MockElement = {
    ...createMockEl('div'),
    children: [],
    cls: options?.cls,
    href: options?.href,
    tag,
    text: options?.text,
    appendText(value) {
      element.text = `${element.text ?? ''}${value}`;
    },
    createDiv(childOptions) {
      const child = createElement('div', childOptions);
      element.children.push(child);
      return child;
    },
    createEl(childTag, childOptions) {
      const child = createElement(childTag, childOptions);
      element.children.push(child);
      return child;
    },
    setText(value) {
      element.text = value;
    },
    toggleClass: jest.fn(),
  };
  return element;
}

function createContainer(): HTMLElement {
  return createElement('div') as unknown as HTMLElement;
}

function makeCatalog() {
  return {
    defaultModelId: 'dsh-4',
    fingerprint: 'catalog',
    models: [
      {
        defaultReasoningEffort: 'medium',
        displayName: 'Dsh 4',
        rawId: 'dsh-4',
        reasoningMetadataResolved: true,
        reasoningEfforts: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
        supportsReasoning: true,
      },
      {
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      },
    ],
    refreshedAt: 100,
  };
}

function createPlugin(): any {
  const plugin: any = {
    storage: { installationKey: mockGetHostnameKey() },
    getEnvironmentVariablesForScope: jest.fn(() => ''),
    mutateSettings: jest.fn(async (mutation: (settings: Record<string, unknown>) => void | Promise<void>) => {
      await mutation(plugin.settings);
    }),
    runProviderExecutionTransition: jest.fn(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => mutation()),
    settings: {
      providerConfigs: {
        dsh: {
          catalogsByHost: { 'device:current': makeCatalog() },
          cliPathsByHost: {},
          enabled: true,
          modelAliases: {},
          preferredReasoningByModel: { 'dsh-4': 'medium' },
          visibleModels: ['dsh-4'],
        },
      },
    },
  };
  plugin.applyProviderRuntimeSettings = jest.fn(async (
    providerIds: string[],
    mutation: (settings: Record<string, unknown>) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ) => plugin.runProviderExecutionTransition(providerIds, async () => {
    await plugin.mutateSettings(mutation);
    await onApplied?.();
  }));
  return plugin;
}

function createContext(plugin: any): any {
  return {
    plugin,
    notifyProviderModelOptionsChanged: jest.fn(),
    renderCustomContextLimits: jest.fn(),
  };
}

function findSetting(name: string): MockSetting {
  const setting = createdSettings.find(candidate => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => mockGetHostnameKey(),
}));

describe('DshSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;
  const mockedAccessSync = fs.accessSync as jest.MockedFunction<typeof fs.accessSync>;

  beforeEach(() => {
    createdSettings.length = 0;
    jest.clearAllMocks();
    mockGetServices.mockReturnValue({
      cliResolver: { reset: mockCLIResolverReset },
      modelCatalog: { refresh: mockRefreshModelCatalog, markStale: jest.fn() },
    });
    mockRefreshModelCatalog.mockResolvedValue({ changed: false });
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
    mockedAccessSync.mockImplementation(() => undefined);
  });

  it('commits Dsh enablement inside a transition without creating metadata', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.dsh.enabled = false;
    let transitionActive = false;
    plugin.runProviderExecutionTransition.mockImplementation(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      transitionActive = true;
      try {
        return await mutation();
      } finally {
        transitionActive = false;
      }
    });
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: Record<string, unknown>) => void | Promise<void>,
    ) => {
      expect(transitionActive).toBe(true);
      await mutation(plugin.settings);
    });
    const context = createContext(plugin);
    dshSettingsTabRenderer.render(createContainer(), context);

    const enableSetting = findSetting('Enable DeepSeek Harness');
    await enableSetting.toggleComponents[0].onChangeCallback?.(true);

    expect(plugin.settings.providerConfigs.dsh.enabled).toBe(true);
    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['dsh'],
      expect.any(Function),
    );
    expect(mockRefreshModelCatalog).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('dsh');
  });

  it('resynchronizes the Dsh toggle when disabling the final provider is rejected', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    dshSettingsTabRenderer.render(createContainer(), context);
    const toggle = findSetting('Enable DeepSeek Harness').toggleComponents[0];
    const coordinator = jest.requireMock('@/core/providers/ProviderSettingsCoordinator')
      .ProviderSettingsCoordinator;
    coordinator.canApplyProviderEnablement.mockImplementationOnce(() => false);
    toggle.value = false;

    await toggle.onChangeCallback?.(false);

    expect(toggle.value).toBe(true);
    expect(plugin.runProviderExecutionTransition).not.toHaveBeenCalled();
    expect(coordinator.applyProviderEnablement).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();

    await toggle.onChangeCallback?.(true);
  });

  it('resynchronizes the Dsh toggle when the enablement transition fails', async () => {
    const plugin = createPlugin();
    const transitionError = new Error('transition failed');
    plugin.runProviderExecutionTransition.mockRejectedValueOnce(transitionError);
    const context = createContext(plugin);
    dshSettingsTabRenderer.render(createContainer(), context);
    const toggle = findSetting('Enable DeepSeek Harness').toggleComponents[0];

    await expect(toggle.onChangeCallback?.(false)).rejects.toBe(transitionError);

    expect(toggle.value).toBe(true);
    expect(plugin.settings.providerConfigs.dsh.enabled).toBe(true);
    expect(plugin.mutateSettings).not.toHaveBeenCalled();
    expect(mockRefreshModelCatalog).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  });

  it('validates an executable CLI file before persisting it', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const plugin = createPlugin();
      dshSettingsTabRenderer.render(createContainer(), createContext(plugin));

      mockedAccessSync.mockImplementation(() => {
        throw new Error('not executable');
      });
      await applyTextInput(findSetting('CLI path').textComponents[0], '/opt/dsh');
      expect(plugin.mutateSettings).not.toHaveBeenCalled();

      mockedAccessSync.mockImplementation(() => undefined);
      await applyTextInput(findSetting('CLI path').textComponents[0], '/opt/dsh');
      expect(getDshProviderSettings(plugin.settings).cliPathsByHost).toEqual({
        'device:current': '/opt/dsh',
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('accepts a CLI path pasted with surrounding quotes', async () => {
    const plugin = createPlugin();
    dshSettingsTabRenderer.render(createContainer(), createContext(plugin));

    mockedExistsSync.mockImplementation((filePath: fs.PathLike) => String(filePath) === '/my tools/dsh');
    await applyTextInput(findSetting('CLI path').textComponents[0], '"/my tools/dsh"');

    expect(getDshProviderSettings(plugin.settings).cliPathsByHost).toEqual({
      'device:current': '"/my tools/dsh"',
    });
  });

  it('retains the CLI path draft for retry after a pre-commit write failure', async () => {
    const plugin = createPlugin();
    const writeError = new Error('write failed');
    plugin.mutateSettings.mockRejectedValueOnce(writeError);
    dshSettingsTabRenderer.render(createContainer(), createContext(plugin));
    const input = findSetting('CLI path').textComponents[0];

    input.inputEl.value = '/opt/dsh';
    await applyTextInput(input, '/opt/dsh');

    expect(getDshProviderSettings(plugin.settings).cliPathsByHost).toEqual({});
    expect(input.inputEl.value).toBe('/opt/dsh');

    input.inputEl.value = '/opt/dsh';
    await expect(applyTextInput(input, '/opt/dsh')).resolves.toBeUndefined();

    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledTimes(2);
    expect(plugin.mutateSettings).toHaveBeenCalledTimes(2);
    expect(getDshProviderSettings(plugin.settings).cliPathsByHost).toEqual({
      'device:current': '/opt/dsh',
    });
  });

  it('keeps a committed CLI path after recycle failure and allows reverting it', async () => {
    const plugin = createPlugin();
    const recycleError = new Error('recycle failed');
    mockCLIResolverReset.mockImplementationOnce(() => {
      throw recycleError;
    });
    dshSettingsTabRenderer.render(createContainer(), createContext(plugin));
    const input = findSetting('CLI path').textComponents[0];

    input.inputEl.value = '/opt/dsh';
    await applyTextInput(input, '/opt/dsh');

    expect(getDshProviderSettings(plugin.settings).cliPathsByHost).toEqual({
      'device:current': '/opt/dsh',
    });
    expect(input.inputEl.value).toBe('/opt/dsh');

    input.inputEl.value = '';
    await expect(applyTextInput(input, '')).resolves.toBeUndefined();

    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledTimes(2);
    expect(plugin.mutateSettings).toHaveBeenCalledTimes(2);
    expect(mockCLIResolverReset).toHaveBeenCalledTimes(2);
    expect(getDshProviderSettings(plugin.settings).cliPathsByHost).toEqual({});
  });

  it('rejects an existing relative CLI path', async () => {
    const plugin = createPlugin();
    dshSettingsTabRenderer.render(createContainer(), createContext(plugin));

    await applyTextInput(findSetting('CLI path').textComponents[0], 'bin/dsh');

    expect(plugin.mutateSettings).not.toHaveBeenCalled();
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it('retains the current catalog and resets the resolver inside a provider execution transition', async () => {
    const plugin = createPlugin();
    let transitionActive = false;
    plugin.runProviderExecutionTransition.mockImplementation(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      transitionActive = true;
      try {
        return await mutation();
      } finally {
        transitionActive = false;
      }
    });
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: Record<string, unknown>) => void | Promise<void>,
    ) => {
      expect(transitionActive).toBe(true);
      await mutation(plugin.settings);
    });
    dshSettingsTabRenderer.render(createContainer(), createContext(plugin));

    await applyTextInput(findSetting('CLI path').textComponents[0], '/opt/dsh');

    expect(getDshProviderSettings(plugin.settings).currentCatalog?.models).toHaveLength(2);
    expect(mockCLIResolverReset).toHaveBeenCalledTimes(1);
    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['dsh'],
      expect.any(Function),
    );
    expect(plugin.applyProviderRuntimeSettings).toHaveBeenCalledWith(
      ['dsh'],
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('renders only the Dsh environment scope without skill or command sections', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const container = createContainer();
    dshSettingsTabRenderer.render(container, context);

    expect(mockRenderEnvironmentSettingsSection).toHaveBeenCalledWith(expect.objectContaining({
      heading: 'Environment',
      plugin,
      scope: 'provider:dsh',
    }));
    const forbiddenSections = [
      'Authentication',
      'Dsh account',
      'Bring your own model',
      'Dsh-native custom models',
      'Agents',
      'Subagents',
    ];
    expect(createdSettings.map(setting => setting.name).filter(name => forbiddenSections.includes(name))).toEqual([]);
    expect(createdSettings.filter(setting => ['Skills', 'Commands', 'Hidden Dsh commands'].includes(setting.name))).toEqual([]);
  });
});

jest.mock('@/shared/settings/ProviderModelsSection', () => ({ renderProviderModelsSection: jest.fn(() => ({ refresh: jest.fn() })) }));
