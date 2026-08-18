// PROTOTYPE — THROWAWAY. Demo app for the cross-origin bridge, adapted from
// ../prototype-synced-preview.app.jsx with ONE change: members live on the
// mock server (window.__MOCK_URL__) instead of in memory — GET /members on
// mount, POST /members on "add". That makes the stateful-shared-mock desync
// reproducible, and the origin-keyed fix demonstrable.
// Compiled by local-demo.mjs at startup (esbuild, minified — the hostile
// no-testids case, same as Part 5).
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Button, Input, Label, TextField, Switch,
  Tabs, TabList, Tab, TabPanel,
  MenuTrigger, Popover, Menu, MenuItem,
  TooltipTrigger, Tooltip,
} from 'react-aria-components';

let BRANCH = { id: '?', label: '?', accent: '#888', inviteLabel: 'Add member' };
const MOCK = window.__MOCK_URL__ || 'http://localhost:4403';

function useHashRoute() {
  const [route, setRoute] = useState(() => location.hash.slice(2) || 'dashboard');
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(2) || 'dashboard');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function withFront(members) {
  return BRANCH.frontCard ? [BRANCH.frontCard, ...members] : members;
}

function Dashboard({ members, filter, setFilter, addMember, setLastAction }) {
  const shown = members.filter(m => m.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="view">
      <div className="row">
        <TextField value={filter} onChange={setFilter} className="field">
          <Label>Filter members</Label>
          <Input placeholder="Type a name…" />
        </TextField>
        <Button className="btn primary" onPress={addMember}>{BRANCH.inviteLabel}</Button>
        <MenuTrigger>
          <Button className="btn">Actions ▾</Button>
          <Popover className="popover">
            <Menu className="menu" onAction={k => setLastAction('menu:' + k)}>
              <MenuItem id="export" className="menu-item">Export CSV</MenuItem>
              <MenuItem id="refresh" className="menu-item">Refresh data</MenuItem>
              {BRANCH.extraMenuItem
                ? <MenuItem id="archive" className="menu-item">Archive team</MenuItem>
                : null}
            </Menu>
          </Popover>
        </MenuTrigger>
        <TooltipTrigger delay={150} closeDelay={150}>
          <Button className="btn icon" aria-label="About this list">i</Button>
          <Tooltip className="tooltip">Members sync nightly from the HR system.</Tooltip>
        </TooltipTrigger>
      </div>
      <div className="member-list">
        {shown.map(m => (
          <Button key={m.name} className="member-row" aria-label={m.name}
                  onPress={() => setLastAction('open:' + m.name)}>
            <span className="avatar">{m.name[0]}</span>
            <span className="m-name">{m.name}</span>
            <span className="m-role">{m.role}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function SettingsView({ state, set }) {
  return (
    <div className="view">
      <Tabs className="tabs">
        <TabList className="tablist" aria-label="Settings sections">
          <Tab id="general" className="tab">General</Tab>
          <Tab id="notifications" className="tab">Notifications</Tab>
        </TabList>
        <TabPanel id="general" className="tabpanel">
          <TextField value={state.teamName} onChange={v => set({ teamName: v })} className="field">
            <Label>Team name</Label>
            <Input />
          </TextField>
          <Switch isSelected={state.publicProfile} onChange={v => set({ publicProfile: v })} className="switch">
            <div className="indicator" /> Public profile
          </Switch>
        </TabPanel>
        <TabPanel id="notifications" className="tabpanel">
          <Switch isSelected={state.emailNotifs} onChange={v => set({ emailNotifs: v })} className="switch">
            <div className="indicator" /> Email notifications
          </Switch>
          <Switch isSelected={state.pushNotifs} onChange={v => set({ pushNotifs: v })} className="switch">
            <div className="indicator" /> Push notifications
          </Switch>
        </TabPanel>
      </Tabs>
    </div>
  );
}

function App() {
  const route = useHashRoute();
  const [members, setMembers] = useState([]);
  const [mockMode, setMockMode] = useState('…');
  const [filter, setFilter] = useState('');
  const [lastAction, setLastAction] = useState('none');
  const [settings, setSettings] = useState({
    teamName: 'Systems Team', publicProfile: false, emailNotifs: true, pushNotifs: false,
  });
  const set = patch => setSettings(s => ({ ...s, ...patch }));

  useEffect(() => {
    fetch(MOCK + '/members')
      .then(r => r.json())
      .then(d => { setMembers(withFront(d.members)); setMockMode(d.mode); })
      .catch(e => console.error('mock fetch failed: ' + e.message));
  }, []);

  const addMember = () => {
    setLastAction('added-member');
    fetch(MOCK + '/members', { method: 'POST' })
      .then(r => r.json())
      .then(d => setMembers(withFront(d.members)))
      .catch(e => console.error('mock post failed: ' + e.message));
  };

  useEffect(() => { console.log('[' + BRANCH.id + '] route -> ' + route); }, [route]);

  return (
    <div className="app">
      <header className="app-head">
        <span className="brand">Teams<span className="badge">{BRANCH.label}</span></span>
        <nav>
          <a href="#/dashboard" className={route === 'dashboard' ? 'on' : ''}>Dashboard</a>
          <a href="#/settings" className={route === 'settings' ? 'on' : ''}>Settings</a>
        </nav>
      </header>
      {route === 'settings'
        ? <SettingsView state={settings} set={set} />
        : <Dashboard members={members} filter={filter} setFilter={setFilter}
                     addMember={addMember} setLastAction={setLastAction} />}
      <footer className="app-status">
        branch:{BRANCH.id} · route:{route} · members:{members.length} · mock:{mockMode} ·
        filter:"{filter}" · public:{String(settings.publicProfile)} · last:{lastAction}
      </footer>
    </div>
  );
}

window.__mountApp = function (branch) {
  BRANCH = branch;
  createRoot(document.getElementById('root')).render(<App />);
};
