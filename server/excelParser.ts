import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client-sqlite';
import { compareSpecs, detectTypeMismatch } from './specUtils.js';
import { nextProjectEntityId } from './entityIds.js';

export interface ParseResult {
  systems: {
    name: string;
    monoblocks: {
      name: string;
      components: {
        name: string;
        title?: string;
        specs: Record<string, string>;
      }[];
    }[];
  }[];
}

/**
 * Parses XML strings of ventilation configuration data.
 */
export function parseXML(xmlText: string): ParseResult {
  const result: ParseResult = { systems: [] };

  // Clean XML comments
  const cleanXml = xmlText.replace(/<!--[\s\S]*?-->/g, '');

  // Look for nested systems using regex
  const systemRegex = /<(?:system|EquipmentSystem)\b([^>]*)>([\s\S]*?)<\/(?:system|EquipmentSystem)>/gi;
  let systemMatch;

  while ((systemMatch = systemRegex.exec(cleanXml)) !== null) {
    const sysAttrs = systemMatch[1];
    const sysContent = systemMatch[2];
    
    const nameMatch = sysAttrs.match(/name=["']([^"']+)["']/i) || sysAttrs.match(/id=["']([^"']+)["']/i);
    const systemName = nameMatch ? nameMatch[1] : `System_${result.systems.length + 1}`;
    
    const monoblocks: any[] = [];
    
    const mbRegex = /<(?:monoblock|Monoblock)\b([^>]*)>([\s\S]*?)<\/(?:monoblock|Monoblock)>/gi;
    let mbMatch;
    while ((mbMatch = mbRegex.exec(sysContent)) !== null) {
      const mbAttrs = mbMatch[1];
      const mbContent = mbMatch[2];
      
      const mbNameMatch = mbAttrs.match(/name=["']([^"']+)["']/i) || mbAttrs.match(/id=["']([^"']+)["']/i);
      const mbName = mbNameMatch ? mbNameMatch[1] : `Monoblock_${monoblocks.length + 1}`;
      
      const components: any[] = [];
      const compRegex = /<(?:component|ComponentElement|componentElement|block)\b([^>]*)>([\s\S]*?)<\/(?:component|ComponentElement|componentElement|block)>/gi;
      let compMatch;
      while ((compMatch = compRegex.exec(mbContent)) !== null) {
        const compAttrs = compMatch[1];
        const compContent = compMatch[2];
        
        const compNameMatch = compAttrs.match(/name=["']([^"']+)["']/i) || compAttrs.match(/id=["']([^"']+)["']/i);
        const compName = compNameMatch ? compNameMatch[1] : `Component_${components.length + 1}`;
        
        const specs: Record<string, string> = {};
        
        // Match parameters with attributes: <parameter name="..." value="..." unit="..." />
        const paramRegex = /<(?:parameter|param|spec)\b([^>]*)\/?>/gi;
        let pMatch;
        while ((pMatch = paramRegex.exec(compContent)) !== null) {
          const attrs = pMatch[1];
          const pName = attrs.match(/name=["']([^"']+)["']/i);
          const pVal = attrs.match(/value=["']([^"']+)["']/i) || attrs.match(/val=["']([^"']+)["']/i);
          const pUnit = attrs.match(/unit=["']([^"']+)["']/i) || attrs.match(/measure=["']([^"']+)["']/i);
          
          if (pName && pVal) {
            const key = pName[1];
            const val = pVal[1];
            const unit = pUnit ? pUnit[1] : '';
            specs[key] = unit ? `${val} ${unit}` : val;
          }
        }
        
        // Match parameters with nested tags: <param><name>X</name><value>Y</value></param>
        const nestedParamRegex = /<(?:parameter|param|spec)>([\s\S]*?)<\/(?:parameter|param|spec)>/gi;
        let nestedPMatch;
        while ((nestedPMatch = nestedParamRegex.exec(compContent)) !== null) {
          const inner = nestedPMatch[1];
          const nameTag = inner.match(/<name>([\s\S]*?)<\/name>/i);
          const valTag = inner.match(/<value>([\s\S]*?)<\/value>/i);
          const unitTag = inner.match(/<unit>([\s\S]*?)<\/unit>/i);
          if (nameTag && valTag) {
            const key = nameTag[1].trim();
            const val = valTag[1].trim();
            const unit = unitTag ? unitTag[1].trim() : '';
            specs[key] = unit ? `${val} ${unit}` : val;
          }
        }
        
        components.push({ name: compName, specs });
      }
      
      monoblocks.push({ name: mbName, components });
    }
    
    result.systems.push({ name: systemName, monoblocks });
  }

  // Backup flat XML structure if there's no system tags
  if (result.systems.length === 0) {
    const rowRegex = /<row>([\s\S]*?)<\/row>/gi;
    let rowMatch;
    const flatRows: any[] = [];
    while ((rowMatch = rowRegex.exec(cleanXml)) !== null) {
      const inner = rowMatch[1];
      const sys = (inner.match(/<system>([\s\S]*?)<\/system>/i) || inner.match(/<systemName>([\s\S]*?)<\/systemName>/i))?.[1]?.trim();
      const mb = (inner.match(/<monoblock>([\s\S]*?)<\/monoblock>/i) || inner.match(/<monoblockName>([\s\S]*?)<\/monoblockName>/i))?.[1]?.trim();
      const comp = (inner.match(/<block>([\s\S]*?)<\/block>/i) || inner.match(/<component>([\s\S]*?)<\/component>/i) || inner.match(/<componentElement>([\s\S]*?)<\/componentElement>/i))?.[1]?.trim();
      if (sys && mb && comp) {
        flatRows.push({ sys, mb, comp });
      }
    }

    if (flatRows.length > 0) {
      const sysMap: Record<string, Record<string, string[]>> = {};
      for (const item of flatRows) {
        if (!sysMap[item.sys]) sysMap[item.sys] = {};
        if (!sysMap[item.sys][item.mb]) sysMap[item.sys][item.mb] = [];
        if (!sysMap[item.sys][item.mb].includes(item.comp)) {
          sysMap[item.sys][item.mb].push(item.comp);
        }
      }
      
      // Parse blocks specs
      const blockSpecsMap: Record<string, Record<string, string>> = {};
      const blockSpecsRegex = /<(?:blockSpecs|componentSpecs|specs)\b([^>]*)>([\s\S]*?)<\/(?:blockSpecs|componentSpecs|specs)>/gi;
      let specMatch;
      while ((specMatch = blockSpecsRegex.exec(cleanXml)) !== null) {
        const attrs = specMatch[1];
        const inner = specMatch[2];
        const nameM = attrs.match(/name=["']([^"']+)["']/i) || attrs.match(/id=["']([^"']+)["']/i);
        if (nameM) {
          const compName = nameM[1];
          const specs: Record<string, string> = {};
          const paramRegex = /<(?:parameter|param|spec)\b([^>]*)\/?>/gi;
          let pm;
          while ((pm = paramRegex.exec(inner)) !== null) {
            const pAttrs = pm[1];
            const pName = pAttrs.match(/name=["']([^"']+)["']/i);
            const pVal = pAttrs.match(/value=["']([^"']+)["']/i);
            const pUnit = pAttrs.match(/unit=["']([^"']+)["']/i);
            if (pName && pVal) {
              specs[pName[1]] = pUnit ? `${pVal[1]} ${pUnit[1]}` : pVal[1];
            }
          }
          blockSpecsMap[compName] = specs;
        }
      }

      for (const [sysName, mbs] of Object.entries(sysMap)) {
        const monoblocksList: any[] = [];
        for (const [mbName, comps] of Object.entries(mbs)) {
          const compsList = comps.map(cName => ({
            name: cName,
            specs: blockSpecsMap[cName] || {}
          }));
          monoblocksList.push({ name: mbName, components: compsList });
        }
        result.systems.push({ name: sysName, monoblocks: monoblocksList });
      }
    }
  }

  return result;
}

/**
 * Resolves a sheet name in the workbook using various fuzzy and exact methods.
 */
function findMatchingSheet(sheetNames: string[], code: string, desc: string = ''): string | null {
  const normSheetNames = sheetNames.map(s => s.toLowerCase().trim());
  const normCode = code.toLowerCase().trim();
  const normDesc = desc?.toLowerCase().trim() || '';

  // 1. Direct exact match by code or description
  let idx = normSheetNames.indexOf(normCode);
  if (idx !== -1) return sheetNames[idx];

  if (normDesc) {
    idx = normSheetNames.indexOf(normDesc);
    if (idx !== -1) return sheetNames[idx];
  }

  // 2. Alphanumeric only match (strips dots, spaces, dashes e.g. "бл2.1" === "бл.2.1" === "бл 2.1")
  const cleanStr = (s: string) => s.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
  const cleanCode = cleanStr(normCode);
  const cleanDesc = cleanStr(normDesc);

  if (cleanCode) {
    idx = normSheetNames.findIndex(sn => cleanStr(sn) === cleanCode);
    if (idx !== -1) return sheetNames[idx];
  }
  if (cleanDesc) {
    idx = normSheetNames.findIndex(sn => cleanStr(sn) === cleanDesc);
    if (idx !== -1) return sheetNames[idx];
  }

  // 3. Substring match
  if (normCode) {
    idx = normSheetNames.findIndex(sn => sn.includes(normCode) || normCode.includes(sn));
    if (idx !== -1) return sheetNames[idx];
  }

  if (cleanCode) {
    idx = normSheetNames.findIndex(sn => cleanStr(sn).includes(cleanCode) || cleanCode.includes(cleanStr(sn)));
    if (idx !== -1) return sheetNames[idx];
  }

  if (normDesc) {
    idx = normSheetNames.findIndex(sn => sn.includes(normDesc) || normDesc.includes(sn));
    if (idx !== -1) return sheetNames[idx];
  }

  return null;
}

/**
 * Parses XLSX files using SheetJS.
 */
export function parseExcel(fileBuffer: Buffer): ParseResult {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const result: ParseResult = { systems: [] };
  const usedSheetNames = new Set<string>();

  const sheetNames = workbook.SheetNames;
  const normalizedSheetNames = sheetNames.map(name => name.toLowerCase().trim());

  console.log(`[Excel Parse] Starting parsing workbook. Total sheets found: ${sheetNames.length} (${sheetNames.join(', ')})`);

  const indexSheetName = sheetNames.find(name => name === '0' || name.toLowerCase().trim() === 'index') || sheetNames[0];
  if (!indexSheetName) {
    console.log(`[Excel Parse] Error: No index sheet found.`);
    return result;
  }

  console.log(`[Excel Parse] Using sheet "${indexSheetName}" as index.`);

  const indexSheet = workbook.Sheets[indexSheetName];
  const rows = XLSX.utils.sheet_to_json<any[]>(indexSheet, { header: 1 });

  let sysCol = -1;
  let mbCol = -1;
  let compCol = -1;

  let startRowIdx = 0;
  if (rows && rows.length > 0) {
    const firstRow = (rows[0] || []).map(c => String(c).toLowerCase());
    const findIndex = (keywords: string[]) => firstRow.findIndex(cell => keywords.some(k => cell.includes(k)));
    
    sysCol = findIndex(['систем', 'system']);
    mbCol = findIndex(['моноблок', 'monoblock', 'mono']);
    compCol = findIndex(['блок', 'компонент', 'block', 'component', 'элемент']);

    if (sysCol !== -1 || mbCol !== -1 || compCol !== -1) {
      startRowIdx = 1;
    }
  }

  // Determine if it is a sequential tree layout (like code and description list)
  let isSequentialTree = (sysCol === -1 || mbCol === -1 || compCol === -1);

  if (isSequentialTree) {
    console.log(`[Excel Parse] Detected sequential hierarchical outline format.`);
    let activeSystem: any = null;
    let activeMonoblock: any = null;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;

      const code = r[0]?.toString().trim();
      const desc = r[1]?.toString().trim() || '';

      if (!code) continue;

      // Skip project overview block pages (like "п")
      if (code.toLowerCase() === 'п' || code.toLowerCase().startsWith('проект')) {
        continue;
      }

      const normalizedCode = code.toLowerCase();
      
      const isSys = /^[уy]\d+$/i.test(code) || normalizedCode.startsWith('установка') || normalizedCode.startsWith('system');
      const isMb = /^[мm][нn]\d+$/i.test(code) || normalizedCode.startsWith('моноблок') || normalizedCode.startsWith('monoblock') || normalizedCode.startsWith('мн');
      
      const isSupplementary = /^(шум|схема|диаг|вент|вспом)/i.test(normalizedCode);
      const isComp = !isSys && !isMb && !isSupplementary && (
        /^[бb][лl]\d+(\.\d+)*$/i.test(code) || 
        normalizedCode.startsWith('блок') || 
        normalizedCode.startsWith('block') || 
        normalizedSheetNames.includes(normalizedCode)
      );

      if (isSys) {
        activeSystem = {
          name: code,
          monoblocks: []
        };
        result.systems.push(activeSystem);
        activeMonoblock = null;
        console.log(`[Excel Parse]   Registered system: "${code}" (${desc})`);

        // Check if there is an equipment sheet for the system itself
        const actualSheetName = findMatchingSheet(sheetNames, code, desc);
        if (actualSheetName) {
          usedSheetNames.add(actualSheetName);
          const sysSheet = workbook.Sheets[actualSheetName];
          if (sysSheet) {
            const specs: Record<string, string> = {};
            const compRows = XLSX.utils.sheet_to_json<any[]>(sysSheet, { header: 1 });
            let paramCount = 0;
            for (const row of compRows) {
              if (!row || row.length === 0) continue;
              const cells = row.map(c => c?.toString().trim()).filter(c => c !== undefined && c !== '');
              if (cells.length >= 2) {
                const param = cells[0];
                const val = cells[1];
                let unit = cells[2] || '';

                const lowerParam = param.toLowerCase();
                if (lowerParam === 'параметр' || lowerParam === 'parameter' || lowerParam === 'свойство' || lowerParam === 'property' || lowerParam === 'наименование параметра') {
                  continue;
                }

                const lowerUnit = unit.toLowerCase();
                if (lowerUnit === 'значение' || lowerUnit === 'ед. изм.' || lowerUnit === 'ед.изм.' || lowerUnit === 'value' || lowerUnit === 'ед') {
                  unit = '';
                }

                specs[param] = unit ? `${val} ${unit}` : val;
                paramCount++;
              }
            }
            console.log(`[Excel Parse]       Found specs for system itself "${code}". Parsed ${paramCount} properties.`);
            
            // Create a general parameters monoblock for the system specs
            const sysGeneralMb = {
              name: `Характеристики ${code}`,
              components: [{
                name: code,
                title: desc || `Общие характеристики ${code}`,
                specs
              }]
            };
            activeSystem.monoblocks.push(sysGeneralMb);
          }
        }
      } else if (isMb) {
        if (!activeSystem) {
          activeSystem = { name: 'у1', monoblocks: [] };
          result.systems.push(activeSystem);
        }
        activeMonoblock = {
          name: desc ? `${code} - ${desc}` : code,
          components: []
        };
        activeSystem.monoblocks.push(activeMonoblock);
        console.log(`[Excel Parse]     Registered monoblock: "${activeMonoblock.name}"`);

        // Check if there is an equipment sheet for the monoblock itself
        const actualSheetName = findMatchingSheet(sheetNames, code, desc);
        if (actualSheetName) {
          usedSheetNames.add(actualSheetName);
          const mbSheet = workbook.Sheets[actualSheetName];
          if (mbSheet) {
            const specs: Record<string, string> = {};
            const compRows = XLSX.utils.sheet_to_json<any[]>(mbSheet, { header: 1 });
            let paramCount = 0;
            for (const row of compRows) {
              if (!row || row.length === 0) continue;
              const cells = row.map(c => c?.toString().trim()).filter(c => c !== undefined && c !== '');
              if (cells.length >= 2) {
                const param = cells[0];
                const val = cells[1];
                let unit = cells[2] || '';

                const lowerParam = param.toLowerCase();
                if (lowerParam === 'параметр' || lowerParam === 'parameter' || lowerParam === 'свойство' || lowerParam === 'property' || lowerParam === 'наименование параметра') {
                  continue;
                }

                const lowerUnit = unit.toLowerCase();
                if (lowerUnit === 'значение' || lowerUnit === 'ед. изм.' || lowerUnit === 'ед.изм.' || lowerUnit === 'value' || lowerUnit === 'ед') {
                  unit = '';
                }

                specs[param] = unit ? `${val} ${unit}` : val;
                paramCount++;
              }
            }
            console.log(`[Excel Parse]       Found specs for monoblock itself "${code}". Parsed ${paramCount} properties.`);
            
            activeMonoblock.components.push({
              name: code,
              title: desc || `Параметры моноблока ${code}`,
              specs
            });
          }
        }
      } else if (isComp) {
        if (!activeSystem) {
          activeSystem = { name: 'у1', monoblocks: [] };
          result.systems.push(activeSystem);
        }
        if (!activeMonoblock) {
          activeMonoblock = { name: 'мн1', components: [] };
          activeSystem.monoblocks.push(activeMonoblock);
        }

        const specs: Record<string, string> = {};
        const actualSheetName = findMatchingSheet(sheetNames, code, desc);

        if (actualSheetName) {
          usedSheetNames.add(actualSheetName);
          const compSheet = workbook.Sheets[actualSheetName];
          if (compSheet) {
            console.log(`[Excel Parse]       Found equipment sheet for component "${code}" (using actual sheet name: "${actualSheetName}")`);
            const compRows = XLSX.utils.sheet_to_json<any[]>(compSheet, { header: 1 });
            let paramCount = 0;
            for (const row of compRows) {
              if (!row || row.length === 0) continue;
              const cells = row.map(c => c?.toString().trim()).filter(c => c !== undefined && c !== '');
              if (cells.length >= 2) {
                const param = cells[0];
                const val = cells[1];
                let unit = cells[2] || '';

                const lowerParam = param.toLowerCase();
                if (lowerParam === 'параметр' || lowerParam === 'parameter' || lowerParam === 'свойство' || lowerParam === 'property' || lowerParam === 'наименование параметра') {
                  continue;
                }

                const lowerUnit = unit.toLowerCase();
                if (lowerUnit === 'значение' || lowerUnit === 'ед. изм.' || lowerUnit === 'ед.изм.' || lowerUnit === 'value' || lowerUnit === 'ед') {
                  unit = '';
                }

                specs[param] = unit ? `${val} ${unit}` : val;
                paramCount++;
              }
            }
            console.log(`[Excel Parse]       Successfully parsed ${paramCount} specifications parameters for component "${code}"`);
          } else {
            console.log(`[Excel Parse]       Warning: Registered sheet "${actualSheetName}" was not found or is undefined in workbook.`);
          }
        } else {
          console.log(`[Excel Parse]       Warning: No matching sheet found for component identifier "${code}" (Searched: "${normalizedCode}")`);
        }

        activeMonoblock.components.push({
          name: code,
          title: desc,
          specs
        });
      }
    }
  } else {
    // Column-based multi-column hierarchy with parent cell inheritance fallback
    console.log(`[Excel Parse] Detected column-based tree layout (System: col ${sysCol}, Monoblock: col ${mbCol}, Component: col ${compCol}).`);
    
    // Default assignments if not overridden
    const systemsMap: Record<string, Record<string, string[]>> = {};
    let currentSys = 'у1';
    let currentMb = 'мн1';

    for (let i = startRowIdx; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;

      const sysName = r[sysCol]?.toString().trim();
      const mbName = r[mbCol]?.toString().trim();
      const compName = r[compCol]?.toString().trim();

      if (sysName) currentSys = sysName;
      const sysKey = sysName || currentSys;

      if (mbName) currentMb = mbName;
      const mbKey = mbName || currentMb;

      if (!sysKey) continue;

      if (!systemsMap[sysKey]) {
        systemsMap[sysKey] = {};
      }

      if (mbKey) {
        if (!systemsMap[sysKey][mbKey]) {
          systemsMap[sysKey][mbKey] = [];
        }
        if (compName && !systemsMap[sysKey][mbKey].includes(compName)) {
          systemsMap[sysKey][mbKey].push(compName);
        }
      }
    }

    for (const [sysName, mbs] of Object.entries(systemsMap)) {
      const monoblocksList: any[] = [];
      for (const [mbName, comps] of Object.entries(mbs)) {
        const componentsList: any[] = [];
        for (const compName of comps) {
          const specs: Record<string, string> = {};
          const actualSheetName = findMatchingSheet(sheetNames, compName);

          if (actualSheetName) {
            usedSheetNames.add(actualSheetName);
            const compSheet = workbook.Sheets[actualSheetName];
            if (compSheet) {
              const compRows = XLSX.utils.sheet_to_json<any[]>(compSheet, { header: 1 });
              for (const row of compRows) {
                if (!row || row.length === 0) continue;
                const cells = row.map(c => c?.toString().trim()).filter(c => c !== undefined && c !== '');
                if (cells.length >= 2) {
                  const param = cells[0];
                  const val = cells[1];
                  let unit = cells[2] || '';

                  const lowerParam = param.toLowerCase();
                  if (lowerParam === 'параметр' || lowerParam === 'parameter' || lowerParam === 'свойство' || lowerParam === 'property' || lowerParam === 'наименование параметра') {
                    continue;
                  }

                  const lowerUnit = unit.toLowerCase();
                  if (lowerUnit === 'значение' || lowerUnit === 'ед. изм.' || lowerUnit === 'ед.изм.' || lowerUnit === 'value' || lowerUnit === 'ед') {
                    unit = '';
                  }

                  specs[param] = unit ? `${val} ${unit}` : val;
                }
              }
            }
          }

          componentsList.push({
            name: compName,
            specs
          });
        }
        monoblocksList.push({
          name: mbName,
          components: componentsList
        });
      }
      result.systems.push({
        name: sysName,
        monoblocks: monoblocksList
      });
    }
  }

  // Fallback: If no hierarchy is extracted, parse sheets directly
  if (result.systems.length === 0) {
    console.log(`[Excel Parse] Fallback: No hierarchical systems map parsed. Extracting sheets directly.`);
    const defaultSys = "у1";
    const defaultMb = "мн1";
    const componentsList: any[] = [];

    for (const sheetName of sheetNames) {
      if (sheetName === indexSheetName) continue;
      
      const isSupplementary = /^(шум|схема|диаг|вент|вспом)/i.test(sheetName.toLowerCase().trim());
      if (isSupplementary) continue;

      const specs: Record<string, string> = {};
      const compSheet = workbook.Sheets[sheetName];
      if (compSheet) {
        usedSheetNames.add(sheetName);
        const compRows = XLSX.utils.sheet_to_json<any[]>(compSheet, { header: 1 });
        for (const row of compRows) {
          if (!row || row.length === 0) continue;
          const cells = row.map(c => c?.toString().trim()).filter(c => c !== undefined && c !== '');
          if (cells.length >= 2) {
            const param = cells[0];
            const val = cells[1];
            let unit = cells[2] || '';

            const lowerParam = param.toLowerCase();
            if (lowerParam === 'параметр' || lowerParam === 'parameter' || lowerParam === 'свойство' || lowerParam === 'property' || lowerParam === 'наименование параметра') {
              continue;
            }

            const lowerUnit = unit.toLowerCase();
            if (lowerUnit === 'значение' || lowerUnit === 'ед. изм.' || lowerUnit === 'ед.изм.' || lowerUnit === 'value' || lowerUnit === 'ед') {
              unit = '';
            }

            specs[param] = unit ? `${val} ${unit}` : val;
          }
        }
      }
      componentsList.push({
        name: sheetName,
        specs
      });
    }

    if (componentsList.length > 0) {
      result.systems.push({
        name: defaultSys,
        monoblocks: [{
          name: defaultMb,
          components: componentsList
        }]
      });
    }
  }

  // 4. Ensure any unused tabs/sheets inside the excel workbook that hold data are appended as separate block elements!
  const unusedSheets = sheetNames.filter(sn => sn !== indexSheetName && !usedSheetNames.has(sn));
  if (unusedSheets.length > 0) {
    console.log(`[Excel Parse] Smart Scan: Found ${unusedSheets.length} additional unused layers/sheets in workbook. Appending as separate block elements.`);
    
    // Pick or create a fallback system & monoblock to import them into
    let targetSys = result.systems[0];
    if (!targetSys) {
      targetSys = { name: "у1", monoblocks: [] };
      result.systems.push(targetSys);
    }
    let targetMb = targetSys.monoblocks[0];
    if (!targetMb) {
      targetMb = { name: "мн1", components: [] };
      targetSys.monoblocks.push(targetMb);
    }

    for (const sheetName of unusedSheets) {
      const isSupplementary = /^(шум|схема|диаг|вент|вспом)/i.test(sheetName.toLowerCase().trim());
      if (isSupplementary) continue;

      const specs: Record<string, string> = {};
      const compSheet = workbook.Sheets[sheetName];
      if (compSheet) {
        const compRows = XLSX.utils.sheet_to_json<any[]>(compSheet, { header: 1 });
        let propCount = 0;
        for (const row of compRows) {
          if (!row || row.length === 0) continue;
          const cells = row.map(c => c?.toString().trim()).filter(c => c !== undefined && c !== '');
          if (cells.length >= 2) {
            const param = cells[0];
            const val = cells[1];
            let unit = cells[2] || '';

            const lowerParam = param.toLowerCase();
            if (lowerParam === 'параметр' || lowerParam === 'parameter' || lowerParam === 'свойство' || lowerParam === 'property' || lowerParam === 'наименование параметра') {
              continue;
            }

            const lowerUnit = unit.toLowerCase();
            if (lowerUnit === 'значение' || lowerUnit === 'ед. изм.' || lowerUnit === 'ед.изм.' || lowerUnit === 'value' || lowerUnit === 'ед') {
              unit = '';
            }

            specs[param] = unit ? `${val} ${unit}` : val;
            propCount++;
          }
        }

        // Add the sheet tab data into its own logical block!
        targetMb.components.push({
          name: sheetName,
          title: sheetName,
          specs
        });
        console.log(`[Excel Parse] Imported sheet tab "${sheetName}" directly with ${propCount} specifications.`);
      }
    }
  }

  return result;
}

/**
 * Saves tree structure to SQL using Prisma models with advanced upsert and conflicts tracking.
 */
export async function importParsedDataToDB(projectId: string, parseResult: ParseResult, prisma: PrismaClient, fileName?: string) {
  const importedSystems = [];
  const processedComponentIds: string[] = [];

  // Fetch all existing components for conflict mapping of removed/orphaned items
  const existingComponents = await prisma.componentElement.findMany({
    where: {
      monoblock: {
        system: {
          projectId,
          fileName: fileName || null
        }
      }
    },
    include: {
      tags: true
    }
  });

  for (const sysData of parseResult.systems) {
    // 1. Find or create EquipmentSystem
    let system = await prisma.equipmentSystem.findFirst({
      where: {
        projectId,
        name: sysData.name,
        fileName: fileName || null
      }
    });
    if (!system) {
      system = await prisma.equipmentSystem.create({
        data: {
          id: await nextProjectEntityId(prisma, projectId, 'SYS'),
          projectId,
          name: sysData.name,
          fileName: fileName || null
        }
      });
    }

    const monoblocksResult = [];

    for (const mbData of sysData.monoblocks) {
      // 2. Find or create Monoblock
      let monoblock = await prisma.monoblock.findFirst({
        where: {
          systemId: system.id,
          name: mbData.name
        }
      });
      if (!monoblock) {
        monoblock = await prisma.monoblock.create({
          data: {
            id: await nextProjectEntityId(prisma, projectId, 'MB'),
            systemId: system.id,
            name: mbData.name
          }
        });
      }

      const componentsResult = [];

      for (const compData of mbData.components) {
        // 3. Find unique component element by itemCode (stable unique business-code)
        let component = await prisma.componentElement.findFirst({
          where: {
            monoblockId: monoblock.id,
            itemCode: compData.name
          },
          include: {
            tags: true
          }
        });

        const serializedSpecs = JSON.stringify(compData.specs);

        if (component) {
          const oldSpecsObj = component.specs ? JSON.parse(component.specs) : {};
          const newSpecsObj = compData.specs || {};

          const { isDifferent } = compareSpecs(oldSpecsObj, newSpecsObj);
          const hasTypeMismatch = detectTypeMismatch(component.name, compData.name, oldSpecsObj, newSpecsObj);

          let updatedComponent = component;
          const hasTags = component.tags && component.tags.length > 0;

          if (isDifferent) {
            // Write transaction to history
            await prisma.equipmentHistory.create({
              data: {
                elementId: component.id,
                version: component.version,
                oldSpecs: component.specs,
                newSpecs: serializedSpecs,
                changeType: 'UPDATE'
              }
            });

            let logMessage = '';
            if (hasTags) {
              const specChanges: string[] = [];
              for (const key of Object.keys(newSpecsObj)) {
                if (oldSpecsObj[key] !== newSpecsObj[key]) {
                  specChanges.push(`Параметр "${key}": "${oldSpecsObj[key] || 'нет'}" -> "${newSpecsObj[key]}"`);
                }
              }
              for (const key of Object.keys(oldSpecsObj)) {
                if (!(key in newSpecsObj)) {
                  specChanges.push(`Удален параметр "${key}": "${oldSpecsObj[key]}"`);
                }
              }
              logMessage = specChanges.join('; ');
            }

            // Update Specs and bump internal version
            updatedComponent = await prisma.componentElement.update({
              where: { id: component.id },
              data: {
                specs: serializedSpecs,
                version: component.version + 1,
                name: compData.title || compData.name,
                hasConflict: hasTags || hasTypeMismatch,
                status: (hasTags || hasTypeMismatch) ? 'CONFLICT' : 'OK',
                conflictType: hasTags ? 'SPEC_CHANGE_WITH_TAG' : (hasTypeMismatch ? 'TYPE_MISMATCH' : null),
                conflictLog: logMessage || null
              },
              include: { tags: true }
            });
          } else {
            // No spec change, but check if type mismatch layout needs refresh
            updatedComponent = await prisma.componentElement.update({
              where: { id: component.id },
              data: {
                name: compData.title || compData.name,
                hasConflict: hasTypeMismatch,
                status: hasTypeMismatch ? 'CONFLICT' : 'OK',
                conflictType: hasTypeMismatch ? 'TYPE_MISMATCH' : null
              },
              include: { tags: true }
            });
          }

          processedComponentIds.push(updatedComponent.id);
          componentsResult.push(updatedComponent);
        } else {
          // New Component Element creation
          const newComponent = await prisma.componentElement.create({
            data: {
              id: await nextProjectEntityId(prisma, projectId, 'EQ'),
              monoblockId: monoblock.id,
              name: compData.title || compData.name,
              itemCode: compData.name,
              specs: serializedSpecs,
              version: 1,
              status: 'OK',
              hasConflict: false,
              conflictType: null
            },
            include: {
              tags: true
            }
          });

          // Write create event to history
          await prisma.equipmentHistory.create({
            data: {
              elementId: newComponent.id,
              version: 1,
              oldSpecs: null,
              newSpecs: serializedSpecs,
              changeType: 'CREATE'
            }
          });

          processedComponentIds.push(newComponent.id);
          componentsResult.push(newComponent);
        }
      }
      monoblocksResult.push({ ...monoblock, components: componentsResult });
    }
    importedSystems.push({ ...system, monoblocks: monoblocksResult });
  }

  // 4. Mark missed items with attached tags as "ORPHANED_TAG" instead of physical deletion
  const missedComponents = existingComponents.filter(c => !processedComponentIds.includes(c.id));
  for (const missed of missedComponents) {
    if (missed.tags && missed.tags.length > 0) {
      await prisma.componentElement.update({
        where: { id: missed.id },
        data: {
          hasConflict: true,
          status: 'CONFLICT',
          conflictType: 'ORPHANED_TAG',
          conflictLog: 'Элемент с активными тегами исчез из новой версии файла проекта.'
        }
      });
    } else {
      // Physically delete if there are no project-specific connections / tags
      await prisma.componentElement.delete({
        where: { id: missed.id }
      });
    }
  }

  return importedSystems;
}
