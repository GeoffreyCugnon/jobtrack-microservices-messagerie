import { TEST_USERS } from '../common/test-fixtures';
import { PresenceService } from './presence.service';

describe('PresenceService', () => {
  let presence: PresenceService;

  beforeEach(() => {
    presence = new PresenceService();
  });

  it('reports a user online only after their first socket and offline after the last', () => {
    expect(presence.isOnline(TEST_USERS.alice)).toBe(false);

    expect(presence.connect(TEST_USERS.alice)).toBe(true); // 0 -> 1 : became online
    expect(presence.isOnline(TEST_USERS.alice)).toBe(true);

    expect(presence.disconnect(TEST_USERS.alice)).toBe(true); // 1 -> 0 : became offline
    expect(presence.isOnline(TEST_USERS.alice)).toBe(false);
  });

  it('only flips state on the 0<->1 transitions when multiple sockets are open', () => {
    expect(presence.connect(TEST_USERS.alice)).toBe(true);
    expect(presence.connect(TEST_USERS.alice)).toBe(false); // 2nd socket, still online
    expect(presence.connect(TEST_USERS.alice)).toBe(false); // 3rd socket

    expect(presence.disconnect(TEST_USERS.alice)).toBe(false); // back to 2
    expect(presence.disconnect(TEST_USERS.alice)).toBe(false); // back to 1
    expect(presence.isOnline(TEST_USERS.alice)).toBe(true);
    expect(presence.disconnect(TEST_USERS.alice)).toBe(true); // back to 0
    expect(presence.isOnline(TEST_USERS.alice)).toBe(false);
  });

  it('disconnect on an unknown user is a harmless no-op', () => {
    expect(presence.disconnect(TEST_USERS.carol)).toBe(false);
    expect(presence.isOnline(TEST_USERS.carol)).toBe(false);
  });

  it('filterOnline keeps only the ids currently online', () => {
    presence.connect(TEST_USERS.alice);
    presence.connect(TEST_USERS.bob);
    presence.disconnect(TEST_USERS.bob);

    expect(presence.filterOnline([TEST_USERS.alice, TEST_USERS.bob, TEST_USERS.carol])).toEqual([
      TEST_USERS.alice,
    ]);
    expect(presence.filterOnline([])).toEqual([]);
  });
});
