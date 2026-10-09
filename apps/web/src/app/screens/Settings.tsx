import type { ReactElement } from 'react';
import { useMe } from '../api/queries/people';
import { LogoutButton } from '../shell/LogoutButton';
import type { SettingsSearch } from '../routes/search-params';
import { Icon, type IconName } from '../ui/icons';
import { ApiTokensTab } from './settings/ApiTokensTab';
import { CatalogueSyncTab } from './settings/CatalogueSyncTab';
import { CustomCardsTab } from './settings/CustomCardsTab';
import { FrameColoursTab } from './settings/FrameColoursTab';
import { PasskeysTab } from './settings/PasskeysTab';
import { PeopleTab } from './settings/PeopleTab';
import './settings/settings.css';

type Tab = SettingsSearch['tab'];

const TABS: ReadonlyArray<{
  tab: Tab;
  label: string;
  icon: IconName;
  adminOnly: boolean;
  blurb: string;
  cta: string;
}> = [
  {
    tab: 'passkeys',
    label: 'Your sign-in',
    icon: 'key',
    adminOnly: false,
    blurb: 'Passkeys for your devices.',
    cta: 'Manage passkeys',
  },
  {
    tab: 'frame-colours',
    label: 'Card frames',
    icon: 'sets',
    adminOnly: false,
    blurb: 'Colours per card type, just for you.',
    cta: 'Edit frame colours',
  },
  {
    tab: 'api-tokens',
    label: 'API tokens',
    icon: 'copy',
    adminOnly: false,
    blurb: 'For the AI card skill and scripts.',
    cta: 'Manage tokens',
  },
  {
    tab: 'custom-cards',
    label: 'Custom cards',
    icon: 'plus',
    adminOnly: false,
    blurb: 'Add a physical card TCGdex doesn’t list.',
    cta: 'Add a custom card',
  },
  {
    tab: 'catalogue-sync',
    label: 'Catalogue',
    icon: 'sync',
    adminOnly: true,
    blurb: 'Sync new sets and cards from TCGdex.',
    cta: 'Open catalogue sync',
  },
  {
    tab: 'people',
    label: 'People',
    icon: 'people',
    adminOnly: true,
    blurb: 'Invite, promote, or turn off accounts.',
    cta: 'Manage people',
  },
];

export function Settings({
  search,
  onTab,
}: {
  search: SettingsSearch;
  onTab: (tab: Tab) => void;
}): ReactElement {
  const me = useMe();
  const admin = me.data?.role === 'admin';
  const visible = TABS.filter((entry) => !entry.adminOnly || admin);
  // An admin-only tab in a member's URL (or before the role has loaded) falls back to
  // their sign-in rather than rendering controls they can't use.
  const active: Tab = visible.some((entry) => entry.tab === search.tab) ? search.tab : 'passkeys';

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <div className="settings-header">
        <h1 id="settings-heading">Settings</h1>
        <div className="settings-account">
          {me.data ? <span className="settings-help">Signed in as {me.data.label}</span> : null}
          <LogoutButton icon={<Icon name="logout" />} />
        </div>
      </div>
      <nav className="settings-tabs" aria-label="Settings sections">
        {visible.map((entry) => (
          <button
            key={entry.tab}
            type="button"
            aria-current={entry.tab === active ? 'page' : undefined}
            className={entry.tab === active ? 'settings-tab settings-tab-active' : 'settings-tab'}
            onClick={() => onTab(entry.tab)}
          >
            <Icon name={entry.icon} />
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="settings-layout">
        <div className="settings-main">
          {active === 'passkeys' ? <PasskeysTab /> : null}
          {active === 'frame-colours' ? <FrameColoursTab /> : null}
          {active === 'api-tokens' ? <ApiTokensTab /> : null}
          {active === 'custom-cards' ? <CustomCardsTab /> : null}
          {active === 'catalogue-sync' && admin ? <CatalogueSyncTab /> : null}
          {active === 'people' && admin ? <PeopleTab meId={me.data?.id ?? null} /> : null}
        </div>
        <aside className="settings-aside" aria-label="Other settings">
          {visible
            .filter((entry) => entry.tab !== active)
            .map((entry) => (
              <section key={entry.tab} className="settings-summary">
                <h2>{entry.label}</h2>
                <p className="settings-help">{entry.blurb}</p>
                <button type="button" onClick={() => onTab(entry.tab)}>
                  {entry.cta}
                </button>
              </section>
            ))}
        </aside>
      </div>
    </section>
  );
}
