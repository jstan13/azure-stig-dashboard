/**
 * Settings — one place for the deployment-level knobs that used to live on
 * their own top-level pages (updates, scan schedule) plus the business-hours
 * power schedule.
 *
 * The tab is part of the URL so links and refreshes land where you expect, and
 * the old `/updates` and `/scan-schedule` routes redirect here.
 */
import { Pivot, PivotItem, Stack, Text } from '@fluentui/react';
import { useNavigate, useParams } from 'react-router-dom';
import PowerSchedulePage from './PowerSchedulePage';
import ScanSchedulePage from './ScanSchedulePage';
import UpdatesPage from './UpdatesPage';
import EmassSettingsPage from './EmassSettingsPage';

const TABS = ['power', 'scans', 'updates', 'emass'] as const;
type Tab = (typeof TABS)[number];

const isTab = (value: string | undefined): value is Tab =>
  !!value && (TABS as readonly string[]).includes(value);

export default function SettingsPage() {
  const navigate = useNavigate();
  const { tab } = useParams<{ tab?: string }>();
  const selected: Tab = isTab(tab) ? tab : 'power';

  return (
    <Stack tokens={{ childrenGap: 16 }}>
      <Stack tokens={{ childrenGap: 4 }}>
        <Text variant="xxLarge" style={{ fontWeight: 700 }}>Settings</Text>
        <Text style={{ color: '#605e5c' }}>
          Deployment-wide configuration. Changes are audited and re-checked by the server.
        </Text>
      </Stack>

      <Pivot
        selectedKey={selected}
        styles={{ root: { display: 'flex', flexWrap: 'wrap' } }}
        onLinkClick={(item) => {
          if (item?.props.itemKey) navigate(`/settings/${item.props.itemKey}`);
        }}
      >
        <PivotItem itemKey="power" headerText="Business hours" itemIcon="PowerButton">
          <Stack styles={{ root: { paddingTop: 18 } }}><PowerSchedulePage /></Stack>
        </PivotItem>
        <PivotItem itemKey="scans" headerText="Scan schedule" itemIcon="Calendar">
          <Stack styles={{ root: { paddingTop: 18 } }}><ScanSchedulePage /></Stack>
        </PivotItem>
        <PivotItem itemKey="updates" headerText="Updates" itemIcon="Sync">
          <Stack styles={{ root: { paddingTop: 18 } }}><UpdatesPage /></Stack>
        </PivotItem>
        <PivotItem itemKey="emass" headerText="eMASS" itemIcon="CloudUpload">
          <Stack styles={{ root: { paddingTop: 18 } }}><EmassSettingsPage /></Stack>
        </PivotItem>
      </Pivot>
    </Stack>
  );
}
