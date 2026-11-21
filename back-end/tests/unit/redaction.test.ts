import { describe, expect, it } from 'vitest';

import {
  createRedactor,
  textBlock,
  toolResultBlock,
  type ProviderMessage,
} from '../../src/modules/copilot/provider';

/**
 * Contrat de rédaction PHI : ce qui part vers le fournisseur ne contient
 * plus d'e-mail, de téléphone, d'IBAN, de pièce d'identité ni de nom de
 * patient connu ; la réponse du modèle revient en clair, et la table de
 * symboles survit à un redémarrage via `exportAliases`.
 */
describe('copilot redactor', () => {
  it('masks structured identifiers and rehydrates model output', () => {
    const redactor = createRedactor(true, { salt: 'conversation-1' });
    const text = 'Escribe a ana@example.com o llama al +34 612 345 678. IBAN ES9121000418450200051332.';
    const [user] = redactor.redactOutgoing([{ role: 'user', content: [textBlock(text)] }]);
    const block = user!.content[0]!;
    const outgoing = block.type === 'text' ? block.text : '';

    expect(outgoing).not.toContain('ana@example.com');
    expect(outgoing).not.toContain('612 345 678');
    expect(outgoing).not.toContain('ES9121000418450200051332');
    expect(outgoing.match(/\[PHI_EMAIL_[0-9a-f]+\]/)).not.toBeNull();
    expect(outgoing.match(/\[PHI_PHONE_[0-9a-f]+\]/)).not.toBeNull();
    expect(outgoing.match(/\[PHI_IBAN_[0-9a-f]+\]/)).not.toBeNull();

    // Le modèle recopie les jetons : l'utilisateur lit les vraies valeurs.
    expect(redactor.rehydrate(outgoing)).toBe(text);
  });

  it('keeps the same token across turns and conversations reloaded from aliases', () => {
    const first = createRedactor(true, { salt: 'same-salt' });
    first.redactOutgoing([{ role: 'user', content: [textBlock('Llamar a 612345678')] }]);
    const aliases = first.exportAliases!();
    const token = Object.keys(aliases)[0]!;

    const reloaded = createRedactor(true, { salt: 'same-salt', aliases });
    const [message] = reloaded.redactOutgoing([
      { role: 'user', content: [textBlock('El paciente 612345678 vuelve mañana')] },
    ]);
    const text = message!.content[0]!;
    expect(text.type === 'text' ? text.text : '').toContain(token);
    expect(reloaded.rehydrate(token)).toBe('612345678');
  });

  it('masks known patient names as whole words only', () => {
    const redactor = createRedactor(true, {
      salt: 'names',
      directory: ['Ana López', 'Ana'],
    });
    const [message] = redactor.redactOutgoing([
      { role: 'user', content: [textBlock('Ana López tiene cita. Anabel no es paciente.')] },
    ]);
    const text = message!.content[0]!;
    const outgoing = text.type === 'text' ? text.text : '';
    expect(outgoing).not.toContain('Ana López');
    expect(outgoing).not.toContain('Ana ');
    expect(outgoing).toContain('Anabel'); // pas de coupure au milieu d'un mot
    expect(redactor.rehydrate(outgoing)).toContain('Ana López');
  });

  it('leaves dates and short digit groups alone', () => {
    const redactor = createRedactor(true, { salt: 'dates' });
    const [message] = redactor.redactOutgoing([
      { role: 'user', content: [textBlock('Cita el 2026-11-19 a las 09:30, importe 120 €')] },
    ]);
    const text = message!.content[0]!;
    expect(text.type === 'text' ? text.text : '').toBe('Cita el 2026-11-19 a las 09:30, importe 120 €');
  });

  it('redacts strings nested in tool results', () => {
    const redactor = createRedactor(true, { salt: 'tools' });
    const history: ProviderMessage[] = [
      {
        role: 'tool',
        content: [
          toolResultBlock('call-1', {
            patient: { email: 'ana@example.com', phone: '612345678' },
            ids: ['ok', 3],
          }),
        ],
      },
    ];
    const [message] = redactor.redactOutgoing(history);
    const block = message!.content[0]!;
    const payload = JSON.stringify(block.type === 'tool_result' ? block.content : null);
    expect(payload).not.toContain('ana@example.com');
    expect(payload).not.toContain('612345678');
    expect(payload).toContain('[PHI_EMAIL_');
    expect(payload).toContain('[PHI_PHONE_');
  });

  it('tokens depend on the conversation salt', () => {
    const a = createRedactor(true, { salt: 'a' });
    const b = createRedactor(true, { salt: 'b' });
    const mask = (r: ReturnType<typeof createRedactor>) => {
      const [message] = r.redactOutgoing([{ role: 'user', content: [textBlock('ana@example.com')] }]);
      const block = message!.content[0]!;
      return block.type === 'text' ? block.text : '';
    };
    expect(mask(a)).not.toBe(mask(b));
  });

  it('is a verbatim pass-through when disabled', () => {
    const redactor = createRedactor(false);
    const history: ProviderMessage[] = [{ role: 'user', content: [textBlock('ana@example.com')] }];
    expect(redactor.redactOutgoing(history)).toBe(history);
    expect(redactor.rehydrate('ana@example.com')).toBe('ana@example.com');
  });
});
