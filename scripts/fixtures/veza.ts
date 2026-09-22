/**
 * Выдуманная выгрузка САПР для проверок разбора.
 *
 * Настоящие выгрузки — данные заказчика (номера заказов, объекты, контакты), и
 * в репозитории им не место. Этот файл собран вручную по устройству формата:
 * плоский словарь `<Elements>` с тегами `N<число>`, отдельное дерево
 * `<Structure>`, коллекции отчёта на всех четырёх уровнях.
 *
 * Здесь нарочно собрано то, на чём разбор ломается, если сделать его наивно:
 *
 * — у одной установки обозначение есть, у другой нет;
 * — ниже блока лежат отверстия и материалы (в настоящих файлах их сорок тысяч);
 * — один параметр повторяется с тем же значением, другой — с иным;
 * — есть код параметра, которого нет в словаре, и целая незнакомая группа;
 * — есть нумерованная группа клапана (ptgVARCONN2).
 */

export const VEZA_SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<Root>
  <Elements>
    <N1 cfnName="Заказы" cfnAmount="1" cfnLevel="caeFolder" cfnElement="cadOrdersFolder"/>
    <N2 cfnName="Заказ 000000000-ПРБ" cfnAmount="1" cfnLevel="caeFolder" cfnElement="cadOrderFolder" proTimeLine="10"/>
    <N3 cfnName="Коллекция элементов отчета проект" cfnAmount="1" cfnLevel="caePropCollection" cfnElement="cadReportCollection" proItemCount="3" proReportLevel="Project"/>
    <N4 cfnName="Элемент отчета ptgORDER.ptPRJREF" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgORDER" proReportPropType="ptPRJREF" proReportPropValue="000000000-ПРБ" proMeasureUnit="unNone"/>
    <N5 cfnName="Элемент отчета ptgORDER.ptPRJWHERE" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgORDER" proReportPropType="ptPRJWHERE" proReportPropValue="Пробный объект" proMeasureUnit="unNone"/>
    <N6 cfnName="Элемент отчета ptgНЕИЗВЕСТНО.ptЧтоТо" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgНЕИЗВЕСТНО" proReportPropType="ptЧтоТо" proReportPropValue="42" proMeasureUnit="unNone"/>

    <N10 cfnName="Установки" cfnAmount="1" cfnLevel="caeFolder" cfnElement="cadUnitsFolder"/>
    <N11 cfnName="Установка 1" cfnAmount="1" cfnLevel="caeFolder" cfnElement="cadUnitFolder" proFrontType="frПробная" proFrontName="ПРОБА-100-200-01-УХЛ4" proUnitName="PR-01-AS-001"/>
    <N12 cfnName="Установка 2" cfnAmount="1" cfnLevel="caeFolder" cfnElement="cadUnitFolder" proFrontType="frПробная" proFrontName="ПРОБА-100-200-02-УХЛ4" proUnitName=""/>
    <N13 cfnName="Коллекция элементов отчета установка" cfnAmount="1" cfnLevel="caePropCollection" cfnElement="cadReportCollection" proItemCount="5" proReportLevel="UnitItem"/>
    <N14 cfnName="Элемент отчета ptgPARAMETERS.ptUnitName" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgPARAMETERS" proReportPropType="ptUnitName" proReportPropValue="PR-01-AS-001" proMeasureUnit="unNone"/>
    <N15 cfnName="Элемент отчета ptgCHARACTERISTICS.ptAirFlow" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgCHARACTERISTICS" proReportPropType="ptAirFlow" proReportPropValue="5000" proMeasureUnit="unCubicMeterPerHour"/>
    <N16 cfnName="Элемент отчета ptgNOICE.ptLSUMOUTA" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgNOICE" proReportPropType="ptLSUMOUTA" proReportPropValue="74.5" proMeasureUnit="unDecibelA"/>
    <N17 cfnName="Элемент отчета ptgFAN.ptFanKFactor" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgFAN" proReportPropType="ptFanKFactor" proReportPropValue="470" proMeasureUnit="unPiece2"/>
    <N18 cfnName="Коллекция элементов отчета установка" cfnAmount="1" cfnLevel="caePropCollection" cfnElement="cadReportCollection" proItemCount="1" proReportLevel="UnitItem"/>

    <N20 cfnName="Моноблоки 1" cfnAmount="1" cfnLevel="caeFolder" cfnElement="cadMonoblocksFolder"/>
    <N21 cfnName="Моноблок 1" cfnAmount="1" cfnNote="1" cfnLevel="caeFolder" cfnElement="cadMonoblockFolder" proPosition="1" proWeigt="300" proLength="800" proHeight="1200" proWidth="1000"/>
    <N22 cfnName="Коллекция элементов отчета моноблок" cfnAmount="1" cfnLevel="caePropCollection" cfnElement="cadReportCollection" proItemCount="2" proReportLevel="MonoblockItem"/>
    <N23 cfnName="Элемент отчета ptgMONOBLOCK.ptMASS" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgMONOBLOCK" proReportPropType="ptMASS" proReportPropValue="300" proMeasureUnit="unKilogramm"/>
    <N24 cfnName="Элемент отчета ptgMONOBLOCK.ptBLOCKLENGTH" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgMONOBLOCK" proReportPropType="ptBLOCKLENGTH" proReportPropValue="800" proMeasureUnit="unMillimeter"/>

    <N30 cfnName="Блоки 1" cfnAmount="1" cfnLevel="caeFolder" cfnElement="cadBlocksFolder"/>
    <N31 cfnName="Блок 1.1 Блок воздухоприемный(один горизонтальный клапан)" cfnAmount="1" cfnNote="1.1" cfnLevel="caeFolder" cfnElement="cadBlockFolder" proBlockType="Inlet1up" proSideType="TheLeft"/>
    <N32 cfnName="Блок 1.2 Фильтр карманный" cfnAmount="1" cfnNote="1.2" cfnLevel="caeFolder" cfnElement="cadBlockFolder" proBlockType="Filter" proSideType="TheLeft"/>
    <N33 cfnName="Коллекция элементов отчета блок" cfnAmount="1" cfnLevel="caePropCollection" cfnElement="cadReportCollection" proItemCount="6" proReportLevel="BlockItem"/>
    <N34 cfnName="Элемент отчета ptgBLOCK.ptName" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgBLOCK" proReportPropType="ptName" proReportPropValue="Блок воздухоприемный(один горизонтальный клапан)" proMeasureUnit="unNone"/>
    <N35 cfnName="Элемент отчета ptgBLOCK.ptMASS" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgBLOCK" proReportPropType="ptMASS" proReportPropValue="87" proMeasureUnit="unKilogramm"/>
    <N36 cfnName="Элемент отчета ptgBLOCK.ptRact" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgCARCASS" proReportPropType="ptRact" proReportPropValue="70x50x1,0 ОЦ" proMeasureUnit="unNone"/>
    <N37 cfnName="Элемент отчета ptgVARCONN2.ptACTUATOR" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgVARCONN2" proReportPropType="ptACTUATOR" proReportPropValue="ПР24-С" proMeasureUnit="unNone"/>
    <N38 cfnName="Элемент отчета ptgBLOCK.ptDPA повтор того же" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgBLOCK" proReportPropType="ptDPA" proReportPropValue="30" proMeasureUnit="unPascals"/>
    <N39 cfnName="Элемент отчета ptgBLOCK.ptDPA другое значение" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgBLOCK" proReportPropType="ptDPA" proReportPropValue="45" proMeasureUnit="unPascals"/>

    <N40 cfnName="Коллекция элементов отчета блок" cfnAmount="1" cfnLevel="caePropCollection" cfnElement="cadReportCollection" proItemCount="2" proReportLevel="BlockItem"/>
    <N41 cfnName="Элемент отчета ptgBLOCK.ptName" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgBLOCK" proReportPropType="ptName" proReportPropValue="Фильтр карманный" proMeasureUnit="unNone"/>
    <N42 cfnName="Элемент отчета ptgFILTER.ptEU" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgFILTER" proReportPropType="ptEU" proReportPropValue="G4" proMeasureUnit="unNone"/>

    <N43 cfnName="Элемент отчета ptgMEMOES.ptMemoItems" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgMEMOES" proReportPropType="ptMemoItems" proReportPropValue="&quot;Класс уровня протечки по CEN EN 1751 - 3&quot;,&quot;Таг-номер клапана PR-01-DW-001A&quot;,&quot;Таг-номер привода PR-01-DWD-001, PR-01-DWD-007, PR-01-DWD-004&quot;" proMeasureUnit="unNone"/>

    <N44 cfnName="Блок 1.3 Вентилятор ВСК" cfnAmount="1" cfnNote="1.3" cfnLevel="caeFolder" cfnElement="cadBlockFolder" proBlockType="Fan" proSideType="TheLeft"/>
    <N45 cfnName="Коллекция элементов отчета блок" cfnAmount="1" cfnLevel="caePropCollection" cfnElement="cadReportCollection" proItemCount="4" proReportLevel="BlockItem"/>
    <N46 cfnName="Элемент отчета ptgBLOCK.ptName" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgBLOCK" proReportPropType="ptName" proReportPropValue="Вентилятор ВСК" proMeasureUnit="unNone"/>
    <N47 cfnName="Элемент отчета ptgFAN.ptFanKFactor" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgFAN" proReportPropType="ptFanKFactor" proReportPropValue="470" proMeasureUnit="unPiece2"/>
    <N48 cfnName="Элемент отчета ptgMOTOR.ptNY" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgMOTOR" proReportPropType="ptNY" proReportPropValue="15" proMeasureUnit="unKilowatt"/>
    <N49 cfnName="Элемент отчета ptgMEMOES.ptMemoItems" cfnAmount="1" cfnLevel="caePropCollectionItem" cfnElement="cadReportCollectionItem" proReportPropGroup="ptgMEMOES" proReportPropType="ptMemoItems" proReportPropValue="&quot;Таг-номер вентилятор PR-01-BL-001A, PR-01-BL-002A&quot;" proMeasureUnit="unNone"/>

    <N70 cfnName="Клапан ПРОБА-С-1220-3300-П-П-30-00-00-УХЛ2-02" cfnAmount="1" cfnLevel="caeAssem" cfnElement="cadConnAssem" proMarking="КЛ-1"/>
    <N71 cfnName="Электропривод ПР24-С2-В" cfnAmount="2" cfnLevel="caeDetail" cfnElement="cadConnAct" proMarking="ЭП-1"/>
    <N72 cfnName="Вентилятор ПРОБА62-100-01500-06-1-Г-УХЛ2" cfnAmount="2" cfnLevel="caeAssem" cfnElement="cadFanFreeAssem" proMarking="ВН-1"/>
    <N73 cfnName="Вентилятор ПРОБА62-100" cfnAmount="2" cfnLevel="caeDetail" cfnElement="cadFan" proMarking="ВН-1-1"/>
    <N74 cfnName="Электродвигатель 160М6-УХЛ2-400-IM1001" cfnAmount="2" cfnLevel="caeDetail" cfnElement="cadEMotor" proMarking="ДВ-1"/>
    <N75 cfnName="Уплотнитель D-профиль 9х8" cfnAmount="383.048" cfnLevel="caeMaterial" cfnElement="cadUntyped" proMeasureUnitStr="м"/>
    <N76 cfnName="Увлажнитель паровой ПРОБА-10" cfnAmount="1" cfnLevel="caeAssem" cfnElement="cadSteamHumidifier" proMarking="УВ-1"/>

    <N50 cfnName="Внутренний каркас" cfnAmount="1" cfnLevel="caeFolder" cfnElement="cadInnercarcassFolder" proMarking="ВК-1"/>
    <N51 cfnName="Панель боковая" cfnAmount="4" cfnLevel="caeDetail" cfnElement="cadPanel" proMarking="ПБ-1" proWeigt="12"/>
    <N52 cfnName="Коллекция отверстий" cfnAmount="1" cfnLevel="caeCollection" cfnElement="cadHoleCollection" proHoleCount="128"/>
    <N53 cfnName="Отверстие круглое" cfnAmount="128" cfnLevel="caeGeom" cfnElement="cadCircHole" proDiam="4.2"/>
    <N54 cfnName="Прокат 02-0,7х1250х2500-Ц275" cfnAmount="9.6" cfnLevel="caeMaterial" cfnElement="cadMaterial" proMeasureUnitStr="кг"/>

    <N60 cfnName="Моноблоки 2" cfnAmount="1" cfnLevel="caeFolder" cfnElement="cadMonoblocksFolder"/>
    <N61 cfnName="Моноблок 1" cfnAmount="1" cfnNote="1" cfnLevel="caeFolder" cfnElement="cadMonoblockFolder" proPosition="1" proWeigt="250"/>
  </Elements>
  <Structure>
    <N1 cfnAmount="1">
      <N2 cfnAmount="1">
        <N3 cfnAmount="1">
          <N4 cfnAmount="1"/>
          <N5 cfnAmount="1"/>
          <N6 cfnAmount="1"/>
        </N3>
        <N10 cfnAmount="1">
          <N11 cfnAmount="1">
            <N13 cfnAmount="1">
              <N14 cfnAmount="1"/>
              <N15 cfnAmount="1"/>
              <N16 cfnAmount="1"/>
              <N17 cfnAmount="1"/>
            </N13>
            <N20 cfnAmount="1">
              <N21 cfnAmount="1">
                <N22 cfnAmount="1">
                  <N23 cfnAmount="1"/>
                  <N24 cfnAmount="1"/>
                </N22>
                <N30 cfnAmount="1">
                  <N31 cfnAmount="1">
                    <N33 cfnAmount="1">
                      <N34 cfnAmount="1"/>
                      <N35 cfnAmount="1"/>
                      <N36 cfnAmount="1"/>
                      <N37 cfnAmount="1"/>
                      <N38 cfnAmount="1"/>
                      <N39 cfnAmount="1"/>
                      <N43 cfnAmount="1"/>
                    </N33>
                    <N70 cfnAmount="1">
                      <N71 cfnAmount="2"/>
                    </N70>
                    <N50 cfnAmount="1">
                      <N51 cfnAmount="4">
                        <N52 cfnAmount="1">
                          <N53 cfnAmount="128"/>
                        </N52>
                        <N54 cfnAmount="9.6"/>
                      </N51>
                    </N50>
                  </N31>
                  <N32 cfnAmount="1">
                    <N40 cfnAmount="1">
                      <N41 cfnAmount="1"/>
                      <N42 cfnAmount="1"/>
                    </N40>
                  </N32>
                  <N44 cfnAmount="1">
                    <N45 cfnAmount="1">
                      <N46 cfnAmount="1"/>
                      <N47 cfnAmount="1"/>
                      <N48 cfnAmount="1"/>
                      <N49 cfnAmount="1"/>
                    </N45>
                    <N72 cfnAmount="2">
                      <N73 cfnAmount="2"/>
                      <N74 cfnAmount="2"/>
                    </N72>
                    <N75 cfnAmount="383.048"/>
                    <N76 cfnAmount="1"/>
                  </N44>
                </N30>
              </N21>
            </N20>
          </N11>
          <N12 cfnAmount="1">
            <N18 cfnAmount="1"/>
            <N60 cfnAmount="1">
              <N61 cfnAmount="1"/>
            </N60>
          </N12>
        </N10>
      </N2>
    </N1>
  </Structure>
</Root>`;

/** Обычный XML расчёта — на нём разбор САПР срабатывать не должен. */
export const PLAIN_EQUIPMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<расчёт>
  <установка name="П-1" title="Приточная установка">
    <моноблок name="МБ-1" title="Моноблок 1">
      <блок name="Б-1" title="Фильтр карманный">
        <параметр name="Класс фильтрации" unit="">G4</параметр>
      </блок>
    </моноблок>
  </установка>
</расчёт>`;
