export type FileDiffKind = 'New' | 'Modified';

export interface FileDiff {
  path: string;
  kind: FileDiffKind;
  source_size: number | null;
  target_size: number | null;
  checksum_source: string | null;
  checksum_target: string | null;
}

export interface DryRunResult {
  diffs: FileDiff[];
  total_files: number;
  files_to_copy: number;
  files_modified: number;
  bytes_to_copy: number;
}
