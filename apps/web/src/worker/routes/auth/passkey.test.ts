import { describe, expect, it } from 'vitest';
import { passkeyIdentity } from './passkey';

describe('passkey identity', () => {
  it('presents a human account name to passkey managers', () => {
    expect(passkeyIdentity('Gordon Beeming')).toEqual({
      rpName: "Gordon Beeming's Pokédex",
      userName: 'gordon.beeming',
      userDisplayName: 'Gordon Beeming',
    });
  });

  it('falls back safely when the configured label has no account characters', () => {
    expect(passkeyIdentity('  ')).toEqual({
      rpName: "Owner's Pokédex",
      userName: 'owner',
      userDisplayName: 'Owner',
    });
  });
});
