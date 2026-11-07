import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Status } from '../ui';
import type { KitTagView } from '../../lib/docflowKitApi';

export default function TagKitDocuments({ tag, canEdit, onCreate, compact = false }: {
  tag: KitTagView; canEdit: boolean; onCreate: () => void; compact?: boolean;
}) {
  const navigate = useNavigate();
  const [later, setLater] = React.useState(false);
  React.useEffect(() => setLater(false), [tag.id]);
  const missing = tag.requirements.filter(r => r.needed && !r.item && !r.problem).length;
  const covered = new Set(tag.requirements.map(r => r.item?.id).filter(Boolean));
  const others = tag.items.filter(item => !covered.has(item.id));
  const open = (registerId: string, id: string) => navigate(`/docflow?tab=registry&vdr=${encodeURIComponent(registerId)}&item=${encodeURIComponent(id)}`);
  return <section aria-label={`Документы тега ${tag.identifier}`} className="space-y-2">
    {tag.removed && <Status tone="amber">Тег снят. Документы сохранены — решение остаётся за человеком.</Status>}
    {!tag.classId && !tag.removed && <p className="fx-note">Для комплекта выберите класс Каталога в карточке тега.</p>}
    {!!missing && !later && canEdit && <div className="flex flex-wrap items-center gap-2" role="status">
      <span className="fx-note">Для {tag.identifier} по комплекту нужно ещё {missing} документов.</span>
      <Btn onClick={onCreate}>Создать строки</Btn><Btn tone="ghost" onClick={() => setLater(true)}>Позже</Btn>
    </div>}
    {!!tag.requirements.length && <div className="overflow-x-auto"><table className="fx-table w-full" aria-label="Документы по комплекту"><thead><tr><th>Тип</th><th>Документ</th><th>Состояние</th>{!compact && <th>Ревизия / файл</th>}</tr></thead>
      <tbody>{tag.requirements.map(r => <tr key={r.key}><td className="font-mono">{r.docType}</td>
        <td>{r.item ? <button type="button" className="text-left underline" onClick={() => open(r.item!.registerId, r.item!.id)}>{r.item.contractorNo || r.item.ownerNo || r.item.vendorNo || r.title}</button> : r.title}</td>
        <td>{r.problem || r.state}</td>{!compact && <td>{r.item ? `${r.item.revision} · ${r.hasFile ? 'есть файл' : 'нет файла'}` : '—'}</td>}</tr>)}</tbody>
    </table></div>}
    {others.map(item => <button className="fx-li w-full text-left" type="button" key={item.id} onClick={() => open(item.registerId, item.id)}>
      <span className="font-mono">{item.contractorNo || item.ownerNo || item.vdrCode}</span> · {item.titleRu} · ред. {item.revision}
    </button>)}
    {!tag.requirements.length && !others.length && <p className="fx-note">Документов пока нет. Комплект класса задают в настройках ДО проекта.</p>}
  </section>;
}
