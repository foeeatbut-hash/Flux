import React from 'react';
import SectionErrorBoundary from '../components/SectionErrorBoundary';
import WindowsExplorer from '../components/explorer/WindowsExplorer';

export default function WindowsExplorerHost() {
  return <SectionErrorBoundary title="Файлы Windows"><WindowsExplorer /></SectionErrorBoundary>;
}
