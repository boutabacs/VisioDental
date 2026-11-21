import { describe, expect, it } from 'vitest';

import {
  COLUMN_MAP,
  CsvImportError,
  MAX_CSV_ROWS,
  REQUIRED_COLUMNS,
  validatePatientCsv,
} from '../../src/modules/patients/csv';

describe('import CSV de patients', () => {
  it('déclare le même contrat de colonnes que l’API', () => {
    expect([...REQUIRED_COLUMNS].sort()).toEqual(['first_name', 'last_name']);
    // Les colonnes du map sont toutes des champs acceptés par le schéma.
    expect(Object.values(COLUMN_MAP)).toEqual(
      expect.arrayContaining(['first_name', 'last_name', 'email', 'national_id']),
    );
  });

  it('parse un CSV virgule avec guillemets et échappements', () => {
    const csv = Buffer.from(
      'first_name,last_name,email,notes\n"Ana","Martínez","ana@example.com","nota, con coma"\n',
      'utf-8',
    );
    const result = validatePatientCsv(csv);
    expect(result.total).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.valid[0]).toMatchObject({
      first_name: 'Ana',
      last_name: 'Martínez',
      email: 'ana@example.com',
      notes: 'nota, con coma',
    });
    expect(result.lines).toEqual([2]);
  });

  it('détecte le point-virgule d’Excel espagnol', () => {
    const csv = Buffer.from(
      'first_name;last_name;date_of_birth;do_not_contact\nLuis;Pérez;31/12/1980;sí\n',
      'utf-8',
    );
    const result = validatePatientCsv(csv);
    expect(result.valid[0]).toMatchObject({
      first_name: 'Luis',
      date_of_birth: '1980-12-31',
      do_not_contact: true,
    });
  });

  it('accepte le BOM UTF-8', () => {
    const csv = Buffer.from(
      '\ufefffirst_name,last_name\nMarta,Gil\n',
      'utf-8',
    );
    expect(validatePatientCsv(csv).valid).toHaveLength(1);
  });

  it('ignore les lignes vides et les colonnes inconnues', () => {
    const csv = Buffer.from(
      'first_name,last_name,external_reference\n\nAna,Díaz,EXT-1\n\n',
      'utf-8',
    );
    const result = validatePatientCsv(csv);
    expect(result.total).toBe(1);
    expect(result.valid[0]).not.toHaveProperty('external_reference');
  });

  it('rapporte les erreurs ligne par ligne sans rejeter le fichier', () => {
    const csv = Buffer.from(
      'first_name,last_name,email\nAna,Díaz,no-es-email\nLuis,Pérez,luis@example.com\n',
      'utf-8',
    );
    const result = validatePatientCsv(csv);
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.row).toBe(2);
    expect(result.errors[0]!.message).toContain('email');
  });

  it('rejette un fichier sans en-tête ou sans colonne requise', () => {
    expect(() => validatePatientCsv(Buffer.from(''))).toThrow(CsvImportError);
    expect(() => validatePatientCsv(Buffer.from('last_name\nPérez\n'))).toThrow(
      /missing required columns: first_name/,
    );
  });

  it('rejette un encodage non UTF-8', () => {
    const latin1 = Buffer.from([0x66, 0x69, 0x72, 0x73, 0x74, 0x5f, 0x6e, 0x61, 0x6d, 0x65, 0xe9]);
    expect(() => validatePatientCsv(latin1)).toThrow('CSV must be UTF-8 encoded');
  });

  it('plafonne à 1 000 lignes', () => {
    const header = 'first_name,last_name\n';
    const rows = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, index) => `P${index},N${index}`).join('\n');
    expect(() => validatePatientCsv(Buffer.from(header + rows + '\n', 'utf-8'))).toThrow(
      `CSV exceeds ${MAX_CSV_ROWS} rows`,
    );
  });

  it('refuse un fichier de plus de 1 Mio', () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
    expect(() => validatePatientCsv(big)).toThrow('CSV exceeds 1024 KiB');
  });
});
