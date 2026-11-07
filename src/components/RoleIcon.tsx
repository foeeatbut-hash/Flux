import React from 'react';
import {
  ShieldCheck, Briefcase, Airplay, Cpu, User, Users,
  HardHat, Wrench, Ruler, ClipboardList, Calculator, Flame, Code,
} from 'lucide-react';

// Значок роли по её имени из настроек. Список закрытый: роль заводит человек,
// но рисовать её должен набор значков программы, иначе оформление расползётся.
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'shield-check': ShieldCheck,
  'briefcase': Briefcase,
  'airplay': Airplay,
  'cpu': Cpu,
  'user': User,
  'users': Users,
  'hard-hat': HardHat,
  'wrench': Wrench,
  'ruler': Ruler,
  'clipboard-list': ClipboardList,
  'calculator': Calculator,
  'flame': Flame,
  'code': Code,
};

export default function RoleIcon({ name, className }: { name?: string; className?: string }) {
  const Cmp = ICONS[name || 'user'] || User;
  return <Cmp className={className} />;
}
