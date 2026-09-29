import { describe, expect, it } from 'vitest';
import { passkeyIdentity } from './passkey';

describe('passkey identity', () => {
  it('names the site Pokédex and presents a human account name to passkey managers', () => {
    expect(passkeyIdentity('Gordon Beeming')).toEqual({
      rpName: 'Pokédex',
      userName: 'gordon.beeming',
      userDisplayName: 'Gordon Beeming',
    });
  });

  it('falls back safely when the configured label has no account characters', () => {
    expect(passkeyIdentity('  ')).toEqual({
      rpName: 'Pokédex',
      userName: 'member',
      userDisplayName: 'Owner',
    });
  });
});
