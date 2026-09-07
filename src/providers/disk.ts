import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { DiskDriveInfo } from '../types.js';

export class DiskProvider {
  public async sample(configuredDrives: string[]): Promise<DiskDriveInfo[]> {
    const targetPaths: string[] = [];

    if (configuredDrives && configuredDrives.length > 0) {
      targetPaths.push(...configuredDrives);
    } else {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceFolder) {
        targetPaths.push(workspaceFolder);
      } else {
        targetPaths.push('/');
      }
    }

    const results: DiskDriveInfo[] = [];

    for (const mountPath of targetPaths) {
      try {
        const stat = await fs.statfs(mountPath);
        const bsize = stat.bsize;
        const totalBytes = stat.blocks * bsize;
        const freeBytes = stat.bavail * bsize;
        const usedBytes = Math.max(0, totalBytes - freeBytes);

        const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
        const freePercent = Math.max(0, 100 - usedPercent);

        results.push({
          mountPath,
          totalBytes,
          freeBytes,
          usedBytes,
          usedPercent,
          freePercent,
        });
      } catch {
        // Path inaccessible, unmounted, or permission denied
      }
    }

    return results;
  }
}
