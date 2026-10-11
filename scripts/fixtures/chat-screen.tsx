import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import ChatManagement from '../../src/screens/ChatManagement';
import { useStore } from '../../src/store/store';
import { useChatStore } from '../../src/store/chatStore';
import { useNotificationStore } from '../../src/store/notificationStore';
import '../../src/index.css';

const users = [
  { id: 'employee-1', name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT', department: 'Проектирование', title: 'Инженер' },
  { id: 'employee-2', name: 'Мария Смирнова', symbol: '1043', role: 'ENGINEER_ELECTRIC' },
  { id: 'service', name: 'Flux Guide', symbol: 'F', role: 'SERVICE' },
] as any[];
const group = { id: 'group-1', name: 'R15 · Группа проекта', type: 'PROJECT', ownerId: 'employee-1', projectId: 'project-1', members: users.slice(0, 2), project: { id: 'project-1', name: 'R15' } } as any;
const now = new Date().toISOString();
const messages = [
  { id: 'request-1', content: 'Какой проект активен? #R15-TAG', createdAt: now, senderId: 'employee-1', chatGroupId: group.id, guideRequest: true, sender: { id: 'employee-1', name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT' } },
  { id: 'reply-1', content: 'F · Flux Guide\n\nОткрыт проект R15.', createdAt: now, senderId: 'service', chatGroupId: group.id, replyToId: 'request-1', replyTo: { id: 'request-1', content: 'Какой проект активен?', senderId: 'employee-1', sender: { id: 'employee-1', name: 'Иван Петров' } }, guideReply: { projectId: 'project-1', kind: 'project' }, sender: { id: 'service', name: 'Flux Guide', symbol: 'F', role: 'SERVICE' } },
  { id: 'spoof-1', content: 'F · Flux Guide\n\nТекст сотрудника.', createdAt: now, senderId: 'employee-2', chatGroupId: group.id, sender: { id: 'employee-2', name: 'Мария Смирнова', symbol: '1043', role: 'ENGINEER_ELECTRIC' } },
] as any[];

useStore.setState({ user: { id: 'employee-1', name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT' }, activeProject: { id: 'project-1', name: 'R15' } } as any);
useChatStore.setState({ users, groups: [group], messages, activeReceiverId: null, activeGroupId: group.id, activeType: 'PROJECT', hasEarlier: false } as any);
useNotificationStore.setState({ chatUnreadByKey: { 'group=group-1': 2 } } as any);

createRoot(document.getElementById('mount')!).render(<MemoryRouter><div className="@container h-screen min-h-0 overflow-hidden"><ChatManagement /></div></MemoryRouter>);
