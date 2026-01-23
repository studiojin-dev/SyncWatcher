import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useYamlStore } from './useYamlStore';
import * as yaml from 'js-yaml';
import { invoke } from '@tauri-apps/api/core';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

describe('useYamlStore', () => {
  const defaultData = {
    key: 'value',
    nested: {
      item: true,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue('');
  });

  it('should load default data when file does not exist', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('File not found')); // read_yaml_file fails

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    await waitFor(() => {
      expect(result.current.data).toEqual(defaultData);
      expect(result.current.loaded).toBe(true);
    });
  });

  it('should parse and load YAML data from file', async () => {
    const yamlContent = yaml.dump(defaultData);
    mockInvoke.mockResolvedValueOnce(yamlContent);

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    await waitFor(() => {
      expect(result.current.data).toEqual(defaultData);
    });
  });

  it('should reject YAML files larger than 1MB', async () => {
    // Create a YAML content larger than 1MB
    const largeContent = 'x'.repeat(1024 * 1024 + 1);

    // Mock the invoke chain
    mockInvoke.mockResolvedValueOnce('/config/dir') // get_app_config_dir
      .mockResolvedValueOnce('/config/dir/test.yaml') // join_paths
      .mockResolvedValueOnce(largeContent); // read_yaml_file

    // Mock alert
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    await waitFor(() => {
      expect(result.current.data).toEqual(defaultData);
      expect(alertMock).toHaveBeenCalledWith(
        expect.stringContaining('Configuration file is too large')
      );
    });

    alertMock.mockRestore();
  });

  it('should handle empty YAML files', async () => {
    mockInvoke.mockResolvedValueOnce('');

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    await waitFor(() => {
      expect(result.current.data).toEqual(defaultData);
    });
  });

  it('should handle YAML parse errors gracefully', async () => {
    // Return invalid YAML that will fail to parse
    const invalidYaml = ': : :\ninvalid: [[[[';
    mockInvoke.mockResolvedValueOnce('/config/dir')
      .mockResolvedValueOnce('/config/dir/test.yaml')
      .mockResolvedValueOnce(invalidYaml);

    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    await waitFor(() => {
      expect(result.current.data).toEqual(defaultData);
      expect(alertMock).toHaveBeenCalled();
    });

    alertMock.mockRestore();
  });

  it('should validate parsed data structure', async () => {
    // Return invalid YAML (null or not an object)
    mockInvoke.mockResolvedValueOnce('null');

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    await waitFor(() => {
      expect(result.current.data).toEqual(defaultData);
    });
  });

  it('should save data to YAML file', async () => {
    mockInvoke.mockResolvedValue('');

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    const newData = { key: 'updated', nested: { item: false } };

    await act(async () => {
      await result.current.saveData(newData);
    });

    // Verify invoke was called with write_yaml_file
    expect(mockInvoke).toHaveBeenCalledWith('write_yaml_file', {
      path: expect.any(String),
      content: expect.stringContaining('updated'),
    });
  });

  it('should validate YAML size before saving', async () => {
    mockInvoke.mockResolvedValue('');

    // Create data larger than 1MB when dumped
    const largeData = {
      key: 'x'.repeat(1024 * 1024),
      nested: { item: true },
    } as typeof defaultData;

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    await expect(async () => {
      await act(async () => {
        await result.current.saveData(largeData);
      });
    }).rejects.toThrow('Configuration too large');
  });

  it('should handle save errors gracefully', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Write failed'));

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    await expect(async () => {
      await act(async () => {
        try {
          await result.current.saveData(defaultData);
        } catch (err) {
          expect(err).toBeTruthy();
        }
      });
    }).not.toThrow();
  });

  it('should mark as loaded after load attempt', async () => {
    mockInvoke.mockResolvedValueOnce(yaml.dump(defaultData));

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
  });

  it('should provide setData function to update data directly', async () => {
    mockInvoke.mockResolvedValueOnce(yaml.dump(defaultData));

    const { result } = renderHook(() => useYamlStore({
      fileName: 'test.yaml',
      defaultData,
    }));

    const newData = { key: 'direct update', nested: { item: false } };

    act(() => {
      result.current.setData(newData);
    });

    expect(result.current.data).toEqual(newData);
  });
});
