import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../../config';

/**
 * Abstraction de stockage — port de `backend/app/modules/media/storage/`
 * (`base.py`, `local.py`, `__init__.py`).
 *
 * Le backend FastAPI expose QUATRE méthodes (`store`, `retrieve`, `delete`,
 * `exists`) et deux implémentations : disque local (`STORAGE_BACKEND=local`,
 * défaut) et S3 (`boto3`). Seul le disque local est porté ici : ses clés
 * sont les mêmes chemins relatifs que ceux du backend S3, donc un volume
 * existant (ou un bucket monté) reste directement lisible.
 */
export interface StorageBackend {
  /** Écrit `data` au chemin relatif `key` ; renvoie le chemin écrit. */
  store(data: Buffer, key: string): Promise<string>;
  /** Lit le fichier ; `null` s'il n'existe pas (équivalent `FileNotFoundError`). */
  retrieve(key: string): Promise<Buffer | null>;
  /** Supprime le fichier ; `false` si la clé n'existait pas. */
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}

export class LocalStorageBackend implements StorageBackend {
  constructor(readonly basePath: string) {
    // Comme `LocalStorageBackend.__init__` : le répertoire racine existe
    // dès l'instanciation du backend.
    fs.mkdir(this.basePath, { recursive: true }).catch(() => undefined);
  }

  private fullPath(key: string): string {
    // `path.join` comme `Path(base) / key` : une clé absolue reste sous la
    // racine (jamais de lecture hors du volume média).
    return path.join(this.basePath, key);
  }

  async store(data: Buffer, key: string): Promise<string> {
    const target = this.fullPath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return key;
  }

  async retrieve(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.fullPath(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await fs.unlink(this.fullPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.fullPath(key));
      return true;
    } catch {
      return false;
    }
  }
}

let cachedBackend: StorageBackend | null = null;
let testStoragePath: string | null = null;

/** Port de `set_test_storage_path` (invalide le singleton). */
export function setTestStoragePath(dir: string | null): void {
  testStoragePath = dir;
  cachedBackend = null;
}

/**
 * Port de `get_storage_backend` : singleton `lru_cache`.
 *
 * Différence assumée : `STORAGE_BACKEND=s3` n'est pas implémenté côté
 * Express (pas de SDK dans les dépendances). On retombe sur le disque local
 * plutôt que de faire échouer le boot — voir le rapport de portage.
 */
export function getStorageBackend(): StorageBackend {
  if (cachedBackend) return cachedBackend;
  const dir = testStoragePath ?? config.mediaRoot;
  cachedBackend = new LocalStorageBackend(dir);
  return cachedBackend;
}
