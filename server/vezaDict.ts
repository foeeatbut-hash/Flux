/**
 * Словарь выгрузки САПР вентиляционного оборудования (XML «Root/Elements»).
 *
 * В файле нет ни одного русского названия параметра: есть код группы
 * (`ptgCOILS`), код параметра (`ptFTO`) и код единицы (`unSquareMeter`).
 * Без словаря импорт завёл бы в реестр строки вида «ptgCOILS||ptFTO = 254»,
 * то есть мусор: по такому ключу инженер ничего не найдёт, а сборка данных в
 * таблицу (там ключи видны человеку) стала бы нечитаемой.
 *
 * Правило словаря — не выдумывать. Названо то, что читается уверенно: код,
 * группа, единица и живое значение вместе не оставляют выбора («ptgWATER.ptGW
 * = 23045 кг/ч» — это расход воды, и ничем другим быть не может). Там, где
 * уверенности нет, название НЕ придумывается: параметр остаётся под своим
 * кодом и помечается неопознанным. Пусть лучше в карточке стоит «ptRact», чем
 * правдоподобная выдумка, которую инженер примет за факт и подставит в расчёт.
 *
 * Словарь собран по 23 настоящим выгрузкам (40 групп, 286 пар «группа.тип»,
 * 29 единиц); сами файлы — данные заказчика и в репозиторий не попадают.
 */

/** Единицы измерения выгрузки → канонические обозначения программы. */
export const VEZA_UNITS: Record<string, string> = {
  unNone: '',
  // «unPiece2» стоит у безразмерных величин (K-фактор, доля, отношение) —
  // это не штуки, и подставлять «шт» было бы враньём
  unPiece2: '',
  unPiece: 'шт',
  unMillimeter: 'мм',
  unMeter: 'м',
  unSquareMeter: 'м²',
  unLitre: 'л',
  unCubicMeterPerHour: 'м³/ч',
  unMeterPerSecond: 'м/с',
  unPascals: 'Па',
  unKilopascals: 'кПа',
  unMillimeterOfMercury: 'мм рт. ст.',
  unKilogramm: 'кг',
  unKilogrammPerHour: 'кг/ч',
  unKilogrammPerCubicMeter: 'кг/м³',
  unKilogramPerSquareMeterPerSecond: 'кг/(м²·с)',
  unGrammPerKilogramm: 'г/кг',
  unKilojoulePerKilogramm: 'кДж/кг',
  unCelsiusDegree: '°C',
  unKilowatt: 'кВт',
  unKiloVoltAmper: 'кВ·А',
  unAmper: 'А',
  unVoltage: 'В',
  unHertz: 'Гц',
  unRevolutionPerMinute: 'об/мин',
  unPerCent: '%',
  unDecibel: 'дБ',
  unDecibelA: 'дБ(А)',
  unSecond: 'с',
};

/** Группы параметров → названия разделов карточки. */
export const VEZA_GROUPS: Record<string, string> = {
  ptgORDER: 'Заказ',
  ptgIN: 'Запрос',
  ptgADMINISTRANT: 'Поставщик',
  ptgCUSTOMER: 'Заказчик',
  ptgMEMOES: 'Примечания',
  ptgATTENTION: 'Особые условия',

  ptgPARAMETERS: 'Параметры установки',
  ptgCHARACTERISTICS: 'Характеристики установки',
  ptgUnitDesign: 'Исполнение',
  ptgUnitDesignSpecial: 'Особое исполнение',
  ptgCARCASS: 'Каркас',
  ptgPANEL: 'Панели',
  ptgFRAME: 'Рама',
  ptgCONTROLS: 'Состав',
  ptgACCSS: 'Комплектация',
  ptgEQUIP: 'Оборудование',

  ptgMONOBLOCK: 'Моноблок',
  ptgBLOCK: 'Блок',

  ptgAIR: 'Воздух',
  ptgSAIR: 'Наружный воздух',
  ptgEAIR: 'Удаляемый воздух',
  ptgMIXT: 'Смесь',
  ptgMIXTPARAM: 'Параметры смешения',
  ptgWORKPNT: 'Рабочая точка',
  ptgNOICE: 'Шум',
  ptgDecision: 'Расчёт',

  ptgFAN: 'Вентилятор',
  ptgMOTOR: 'Электродвигатель',
  ptgEMOTORADJUST: 'Регулирование двигателя',

  ptgFILTER: 'Фильтр',
  ptgFILTERCELLS: 'Фильтрующие кассеты',

  ptgCOILS: 'Теплообменник',
  ptgWATER: 'Вода',
  ptgWATERSUPP: 'Узел обвязки',
  ptgFREON: 'Хладагент',
  ptgDKIN: 'Подвод',
  ptgDKOUT: 'Отвод',

  ptgVARCONN: 'Клапан',
  ptgVARCONN1: 'Клапан 1',
  ptgVARCONN2: 'Клапан 2',
};

/**
 * Параметры: «группа.код» → название.
 *
 * Ключ полный, с группой: один и тот же `ptMASS` значит «масса блока» в
 * `ptgBLOCK` и «масса двигателя» в `ptgMOTOR`, и короткий ключ слил бы их.
 */
export const VEZA_PROPS: Record<string, string> = {
  // ── Заказ и стороны ──
  'ptgORDER.ptPRJREF': 'Номер заказа',
  'ptgORDER.ptPRJWHERE': 'Объект',
  'ptgORDER.ptPRJPLACEID1': 'Шифр объекта',
  'ptgORDER.ptPRJPLACEID2': 'Обозначение по проекту',
  'ptgORDER.ptDATETIME': 'Дата заказа',
  'ptgIN.ptInDateTime': 'Дата запроса',
  'ptgIN.ptInRef': 'Номер запроса',
  'ptgADMINISTRANT.ptCOMPANY': 'Поставщик',
  'ptgADMINISTRANT.ptADDRESS': 'Адрес поставщика',
  'ptgADMINISTRANT.ptPHONE': 'Телефон',
  'ptgADMINISTRANT.ptFAX': 'Факс',
  'ptgADMINISTRANT.ptEMAIL': 'Почта',
  'ptgADMINISTRANT.ptSignature': 'Подпись',
  'ptgCUSTOMER.ptCOMPANY': 'Заказчик',
  'ptgCUSTOMER.ptCITY': 'Город',
  'ptgMEMOES.ptMemoItems': 'Примечания',
  'ptgATTENTION.ptOversizeCargo': 'Негабаритный груз',

  // ── Установка ──
  'ptgPARAMETERS.ptHVACSystemType': 'Тип установки',
  'ptgPARAMETERS.ptAIRDirect': 'Назначение',
  'ptgPARAMETERS.ptUnitName': 'Обозначение установки',
  'ptgPARAMETERS.ptSize': 'Типоразмер',
  'ptgPARAMETERS.ptSideType': 'Сторона обслуживания',
  'ptgPARAMETERS.ptAirFlowFanR': 'Расход воздуха через вентилятор',
  'ptgPARAMETERS.ptDPAUNIT': 'Сопротивление установки',
  'ptgPARAMETERS.ptDPNETIN': 'Давление сети на входе',
  'ptgPARAMETERS.ptDPNETOUT': 'Давление сети на выходе',
  'ptgPARAMETERS.ptALTIT': 'Высота над уровнем моря',
  'ptgPARAMETERS.ptTAIR': 'Температура воздуха в помещении',

  'ptgCHARACTERISTICS.ptAirFlow': 'Расход воздуха',
  'ptgCHARACTERISTICS.ptDPNET': 'Давление в сети',
  'ptgCHARACTERISTICS.ptPV': 'Полное давление',
  'ptgCHARACTERISTICS.ptBlockCount': 'Количество блоков',
  'ptgCHARACTERISTICS.ptMonoblockCount': 'Количество моноблоков',
  'ptgCHARACTERISTICS.ptTotalInstallPower': 'Установленная мощность',
  'ptgCHARACTERISTICS.ptWeigtTotal': 'Масса установки',
  'ptgCHARACTERISTICS.ptWeigtFirst': 'Масса первого яруса',
  'ptgCHARACTERISTICS.ptWeigtSecond': 'Масса второго яруса',

  'ptgUnitDesign.ptIsCustom': 'Вид установки',
  'ptgUnitDesign.ptOptions': 'Опции',
  'ptgUnitDesign.ptSpecificationsCode': 'Технические условия',
  'ptgUnitDesign.ptUnitDesignUsedFor': 'Назначение исполнения',
  'ptgUnitDesign.ptUnitDesignClimatic': 'Климатическое исполнение',
  'ptgUnitDesign.ptUnitDesignBased': 'Основание',
  'ptgUnitDesign.ptUnitDesignPainted': 'Окраска',
  'ptgUnitDesignSpecial.ptFreeMonoblock': 'Свободный моноблок',
  'ptgUnitDesignSpecial.ptCommonPainted': 'Общая окраска',
  'ptgUnitDesignSpecial.ptDoorKeyLock': 'Замок с ключом',
  'ptgUnitDesignSpecial.ptAddCaseJoint': 'Дополнительный стык корпуса',

  'ptgCARCASS.ptConer': 'Угловой элемент',
  'ptgCARCASS.ptRigel': 'Ригель',
  'ptgPANEL.ptPanelThickness': 'Толщина панели',
  'ptgPANEL.ptPanelPainted': 'Окраска панелей',
  'ptgPANEL.ptPanelMaterialOuter': 'Материал наружной обшивки',
  'ptgPANEL.ptPanelMaterialInner': 'Материал внутренней обшивки',
  'ptgPANEL.ptPanelInsulation': 'Утеплитель',
  'ptgFRAME.ptFrameHeight': 'Высота рамы',
  'ptgFRAME.ptFramelMaterial': 'Материал рамы',
  'ptgCONTROLS.ptMarking': 'Состав установки',
  'ptgCONTROLS.ptINDEX': 'Индекс',

  'ptgACCSS.ptAirMeasuringHatch': 'Лючок для замеров',
  'ptgACCSS.ptAirThermostatUnit': 'Термостат воздуха',
  'ptgACCSS.ptBlockLighting': 'Освещение блока',
  'ptgACCSS.ptDpaSensor': 'Датчик перепада давления',
  'ptgACCSS.ptDroplet': 'Каплеуловитель',
  'ptgACCSS.ptServiceSwitchKit': 'Ремонтный выключатель',
  'ptgACCSS.ptSpareFilterCells': 'Запасные фильтрующие кассеты',
  'ptgACCSS.ptSpareFilterCells2': 'Запасные фильтрующие кассеты',
  'ptgACCSS.ptWaterSupply': 'Узел обвязки',
  'ptgACCSS.ptWaterTank': 'Поддон',
  'ptgEQUIP.ptMODEL': 'Модель',
  'ptgEQUIP.ptISLENGTHSTD': 'Стандартная длина',

  // ── Моноблок и блок ──
  'ptgMONOBLOCK.ptPosition': 'Позиция',
  'ptgMONOBLOCK.ptFloor': 'Ярус',
  'ptgMONOBLOCK.ptBlockCount': 'Количество блоков',
  'ptgMONOBLOCK.ptBLOCKLENGTH': 'Длина',
  'ptgMONOBLOCK.ptBLOCKWIDTH': 'Ширина',
  'ptgMONOBLOCK.ptBLOCKHEIGHT': 'Высота',
  'ptgMONOBLOCK.ptMASS': 'Масса',
  'ptgMONOBLOCK.ptDPA': 'Аэродинамическое сопротивление',

  'ptgBLOCK.ptPosition': 'Позиция',
  'ptgBLOCK.ptName': 'Наименование',
  'ptgBLOCK.ptBlockType': 'Тип блока',
  'ptgBLOCK.ptFloor': 'Ярус',
  'ptgBLOCK.ptSideType': 'Сторона обслуживания',
  'ptgBLOCK.ptBLOCKLENGTH': 'Длина',
  'ptgBLOCK.ptBLOCKWIDTH': 'Ширина',
  'ptgBLOCK.ptBLOCKHEIGHT': 'Высота',
  'ptgBLOCK.ptMASS': 'Масса',
  'ptgBLOCK.ptDPA': 'Аэродинамическое сопротивление',
  'ptgBLOCK.ptTotalInstallPower': 'Установленная мощность',
  'ptgBLOCK.ptINCONNECTOR': 'Присоединение на входе',
  'ptgBLOCK.ptOUTCONNECTOR': 'Присоединение на выходе',
  'ptgBLOCK.ptUPCONNECTOR': 'Верхнее присоединение',

  // ── Воздух ──
  'ptgAIR.ptAIRFlowIN': 'Расход воздуха на входе',
  'ptgAIR.ptAIRFlowOUT': 'Расход воздуха на выходе',
  'ptgAIR.ptAIRFlowSTD': 'Расход воздуха номинальный',
  'ptgAIR.ptT1': 'Температура на входе',
  'ptgAIR.ptT2': 'Температура на выходе',
  'ptgAIR.ptT2R': 'Температура на выходе требуемая',
  'ptgAIR.ptI1': 'Энтальпия на входе',
  'ptgAIR.ptI2': 'Энтальпия на выходе',
  'ptgAIR.ptD1': 'Влагосодержание на входе',
  'ptgAIR.ptD2': 'Влагосодержание на выходе',
  'ptgAIR.ptFI1': 'Относительная влажность на входе',
  'ptgAIR.ptFI2': 'Относительная влажность на выходе',
  'ptgAIR.ptPB': 'Барометрическое давление',
  'ptgAIR.ptVRO': 'Массовая скорость в сечении',
  'ptgAIR.ptDPAEQUIP': 'Сопротивление оборудования',

  'ptgSAIR.ptST': 'Температура наружного воздуха',
  'ptgSAIR.ptSI': 'Энтальпия наружного воздуха',
  'ptgSAIR.ptSD': 'Влагосодержание наружного воздуха',
  'ptgSAIR.ptSFI': 'Относительная влажность наружного воздуха',
  'ptgEAIR.ptET': 'Температура удаляемого воздуха',
  'ptgEAIR.ptEI': 'Энтальпия удаляемого воздуха',
  'ptgEAIR.ptED': 'Влагосодержание удаляемого воздуха',
  'ptgEAIR.ptEFI': 'Относительная влажность удаляемого воздуха',
  'ptgMIXT.ptMixtT': 'Температура смеси',
  'ptgMIXT.ptMixtI': 'Энтальпия смеси',
  'ptgMIXT.ptMixtD': 'Влагосодержание смеси',
  'ptgMIXT.ptMixtFI': 'Относительная влажность смеси',
  'ptgMIXTPARAM.ptMixtRatio': 'Доля рециркуляции',
  'ptgMIXTPARAM.ptMoistureLoss': 'Потери влаги',
  'ptgMIXTPARAM.ptPB': 'Барометрическое давление',

  // ── Вентилятор, двигатель, рабочая точка, шум ──
  'ptgFAN.ptINDEX': 'Вентилятор',
  'ptgFAN.ptEQUIPCOUNT': 'Количество',
  'ptgFAN.ptEQUIPWORKCOUNT': 'Количество рабочих',
  'ptgFAN.ptWheelDiam': 'Диаметр рабочего колеса',
  'ptgFAN.ptFanWeigt': 'Масса вентилятора',
  'ptgFAN.ptFanKFactor': 'K-фактор',
  'ptgFAN.ptISOUTLETFREE': 'Свободное выходное сечение',
  'ptgFAN.ptOUTLETDIRECT': 'Направление выхода',
  'ptgFAN.ptOutletNum': 'Количество выходов',
  'ptgFAN.ptOutletWidth': 'Ширина выходного сечения',
  'ptgFAN.ptOutletHeight': 'Высота выходного сечения',

  'ptgMOTOR.ptMOTOR': 'Электродвигатель',
  'ptgMOTOR.ptEQUIPCOUNT': 'Количество',
  'ptgMOTOR.ptEQUIPWORKCOUNT': 'Количество рабочих',
  'ptgMOTOR.ptNY': 'Номинальная мощность',
  'ptgMOTOR.ptMOTORSPEED': 'Частота вращения',
  'ptgMOTOR.pt2P': 'Число полюсов',
  'ptgMOTOR.ptDSH': 'Диаметр вала',
  'ptgMOTOR.ptMASS': 'Масса',
  'ptgMOTOR.ptVOLTAGE': 'Напряжение',
  'ptgMOTOR.ptFREQUENCY': 'Частота сети',
  'ptgMOTOR.ptNominalCurrent': 'Номинальный ток',
  'ptgMOTOR.ptStartingCurrent': 'Пусковой ток',
  'ptgMOTOR.ptLoadFactor': 'Загрузка двигателя',
  'ptgMOTOR.ptMotorCalcResult': 'Результат подбора',
  'ptgEMOTORADJUST.ptEMotorAdjustExist': 'Регулирование',
  'ptgEMOTORADJUST.ptEMotorAdjustFreq': 'Рабочая частота',

  'ptgWORKPNT.ptAirFlowFan': 'Расход воздуха',
  'ptgWORKPNT.ptPV': 'Полное давление',
  'ptgWORKPNT.ptPST': 'Статическое давление',
  'ptgWORKPNT.ptFANSPEED': 'Частота вращения колеса',
  'ptgWORKPNT.ptNP': 'Потребляемая мощность',
  'ptgWORKPNT.ptEFFICIENCY': 'КПД',
  'ptgWORKPNT.ptEFFICIENCYSTATIC': 'Статический КПД',
  'ptgWORKPNT.ptOUTLETSPEED': 'Скорость на выходе',
  'ptgWORKPNT.ptROA': 'Плотность воздуха',

  'ptgNOICE.ptLSUM': 'Уровень звуковой мощности',
  'ptgNOICE.ptLSUMIN': 'Уровень звуковой мощности на входе',
  'ptgNOICE.ptLSUMINA': 'Уровень звуковой мощности на входе, дБ(А)',
  'ptgNOICE.ptLSUMOUT': 'Уровень звуковой мощности на выходе',
  'ptgNOICE.ptLSUMOUTA': 'Уровень звуковой мощности на выходе, дБ(А)',

  // ── Фильтр ──
  'ptgFILTER.ptEU': 'Класс фильтрации',
  'ptgFILTER.ptDPAMID': 'Сопротивление среднее',
  'ptgFILTER.ptFILTERLEN': 'Глубина фильтра',
  'ptgFILTER.ptFILTERMATERIAL': 'Материал фильтра',
  'ptgFILTER.ptFILTEREFFECT': 'Эффективность',
  'ptgFILTER.ptFilterSpeed': 'Скорость в сечении',
  'ptgFILTER.ptFilterCondition': 'Состояние фильтра',
  'ptgFILTERCELLS.ptFilterCellName1': 'Кассета 1',
  'ptgFILTERCELLS.ptFilterCellName2': 'Кассета 2',
  'ptgFILTERCELLS.ptFilterCellName3': 'Кассета 3',
  'ptgFILTERCELLS.ptFilterCellName4': 'Кассета 4',
  'ptgFILTERCELLS.ptFilterCellNum1': 'Количество кассет 1',
  'ptgFILTERCELLS.ptFilterCellNum2': 'Количество кассет 2',
  'ptgFILTERCELLS.ptFilterCellNum3': 'Количество кассет 3',
  'ptgFILTERCELLS.ptFilterCellNum4': 'Количество кассет 4',

  // ── Теплообменник и теплоноситель ──
  'ptgCOILS.ptCoils': 'Теплообменник',
  'ptgCOILS.ptINDEX': 'Обозначение',
  'ptgCOILS.ptEQUIPCOUNT': 'Количество',
  'ptgCOILS.ptCircuits': 'Количество контуров',
  'ptgCOILS.ptCoilsNr': 'Число рядов',
  'ptgCOILS.ptCoilsNx': 'Число ходов',
  'ptgCOILS.ptCoilsSr': 'Шаг оребрения',
  'ptgCOILS.ptCoilsTube': 'Материал трубок',
  'ptgCOILS.ptCoilsFinn': 'Материал оребрения',
  'ptgCOILS.ptCoilsBody': 'Материал корпуса',
  'ptgCOILS.ptCoilsManifold': 'Материал коллектора',
  'ptgCOILS.ptCoilsManifoldConn': 'Присоединение коллектора',
  'ptgCOILS.ptFA': 'Площадь фронтального сечения',
  'ptgCOILS.ptFTO': 'Площадь теплообмена',
  'ptgCOILS.ptFW': 'Живое сечение по теплоносителю',
  'ptgCOILS.ptVOLUME': 'Объём теплоносителя',
  'ptgCOILS.ptMASS': 'Масса',
  'ptgCOILS.ptDIRECT': 'Схема движения',
  'ptgCOILS.ptSideType': 'Сторона подключения',
  'ptgCOILS.ptGROUPS': 'Группы нагрева',
  'ptgCOILS.ptGROUPSMax': 'Группы нагрева, максимум',
  'ptgCOILS.ptQMax': 'Мощность максимальная',
  'ptgCOILS.ptEPowerAdjust': 'Регулирование мощности',

  'ptgWATER.ptTW1': 'Температура на входе',
  'ptgWATER.ptTW2': 'Температура на выходе',
  'ptgWATER.ptTW1R': 'Температура на входе расчётная',
  'ptgWATER.ptTW2R': 'Температура на выходе расчётная',
  'ptgWATER.ptGW': 'Расход теплоносителя',
  'ptgWATER.ptGWMAX': 'Расход теплоносителя максимальный',
  'ptgWATER.ptLw': 'Объёмный расход',
  'ptgWATER.ptDPW': 'Потеря давления',
  'ptgWATER.ptDPWR': 'Располагаемый перепад давления',
  'ptgWATER.ptVELOC': 'Скорость теплоносителя',

  'ptgWATERSUPP.ptINDEX': 'Узел обвязки',
  'ptgWATERSUPP.ptSideType': 'Сторона подключения',
  'ptgWATERSUPP.ptWaterSuppCxema': 'Схема обвязки',
  'ptgWATERSUPP.ptWaterSuppDesign': 'Исполнение узла',
  'ptgWATERSUPP.ptWaterSuppSize': 'Типоразмер узла',
  'ptgWATERSUPP.ptWaterSuppValve': 'Клапан',
  'ptgWATERSUPP.ptCompPower': 'Мощность насоса',
  'ptgWATERSUPP.ptCompCurrentMax': 'Максимальный ток',
  'ptgWATERSUPP.ptVOLTAGE': 'Напряжение',
  'ptgWATERSUPP.ptNumPhase': 'Число фаз',
  'ptgWATERSUPP.ptLwmin': 'Расход минимальный',
  'ptgWATERSUPP.ptLwmax': 'Расход максимальный',
  'ptgWATERSUPP.ptDPWmax': 'Перепад давления максимальный',
  'ptgWATERSUPP.ptTwmin': 'Температура минимальная',
  'ptgWATERSUPP.ptTwmax': 'Температура максимальная',

  'ptgFREON.ptFREONTYPE': 'Хладагент',
  'ptgFREON.ptTe': 'Температура кипения',
  'ptgFREON.ptTc': 'Температура конденсации',
  'ptgFREON.ptPe': 'Давление кипения',
  'ptgFREON.ptPc': 'Давление конденсации',
  'ptgFREON.ptGFR': 'Расход хладагента',
  'ptgFREON.ptTW1': 'Температура на входе',
  'ptgFREON.ptTW2': 'Температура на выходе',
  'ptgFREON.ptDPW': 'Потеря давления',
  'ptgFREON.ptDPWR': 'Располагаемый перепад давления',

  'ptgDKIN.ptDK': 'Диаметр подводящего патрубка',
  'ptgDKIN.ptFlange': 'Фланец подвода',
  'ptgDKIN.ptEQUIPCOUNT': 'Количество подводов',
  'ptgDKOUT.ptDK': 'Диаметр отводящего патрубка',
  'ptgDKOUT.ptFlange': 'Фланец отвода',
  'ptgDKOUT.ptEQUIPCOUNT': 'Количество отводов',

  // ── Расчёт ──
  'ptgDecision.ptTASK': 'Задача расчёта',
  'ptgDecision.ptQH': 'Теплопроизводительность',
  'ptgDecision.ptQHR': 'Теплопроизводительность расчётная',
  'ptgDecision.ptQC': 'Холодопроизводительность',
  'ptgDecision.ptQCSENSIBLE': 'Холодопроизводительность явная',
  'ptgDecision.ptQCLATENT': 'Холодопроизводительность скрытая',
  'ptgDecision.ptGK': 'Количество конденсата',
  'ptgDecision.ptKF': 'Запас по мощности',

  // ── Клапаны ──
  'ptgVARCONN.ptVarConnName': 'Клапан',
  'ptgVARCONN.ptVarConnPos': 'Расположение клапана',
  'ptgVARCONN.ptACTUATOR': 'Электропривод',
  'ptgVARCONN.ptActuatorCount': 'Количество приводов',
  'ptgVARCONN.ptVarConnHeatCap': 'Мощность подогрева',
  'ptgVARCONN.ptVarConnHeatCapMax': 'Мощность подогрева максимальная',
  'ptgVARCONN.ptVarConnHeatCurrent': 'Ток подогрева',
  'ptgVARCONN.ptVarConnHeatCurrentMax': 'Ток подогрева максимальный',
  'ptgVARCONN.ptVarConnHeatPeriod': 'Время прогрева',
  'ptgVARCONN.ptAddSoftConnector': 'Гибкая вставка',
};

// Клапанов в блоке бывает несколько: ptgVARCONN1, ptgVARCONN2 — те же
// параметры, что и у ptgVARCONN. Дублировать таблицу нечестно: разойдётся при
// первой же правке, поэтому нумерованные группы сводятся к базовой.
const VARCONN_NUMBERED = /^ptgVARCONN\d+$/;

/** Каноническая единица по коду выгрузки; незнакомый код остаётся как есть. */
export function vezaUnit(code: string): string {
  const raw = String(code || '').trim();
  if (!raw) return '';
  const hit = VEZA_UNITS[raw];
  return hit === undefined ? raw : hit;
}

/** Название раздела по коду группы; незнакомая группа остаётся кодом. */
export function vezaGroup(code: string): string {
  const raw = String(code || '').trim();
  return VEZA_GROUPS[raw] || raw || 'Прочее';
}

/**
 * Название параметра.
 *
 * `known: false` — словарь этот код не знает. Название тогда равно самому
 * коду: пусть в карточке видно, что программа не поняла параметр, чем стоит
 * выдуманное имя, которому инженер поверит.
 */
export function vezaProp(group: string, type: string): { title: string; known: boolean } {
  const g = String(group || '').trim();
  const t = String(type || '').trim();
  const base = VARCONN_NUMBERED.test(g) ? 'ptgVARCONN' : g;
  const hit = VEZA_PROPS[`${base}.${t}`];
  return hit ? { title: hit, known: true } : { title: t || '—', known: false };
}

/** Уровень коллекции отчёта: к чему относятся её параметры. */
export type VezaLevel = 'order' | 'unit' | 'monoblock' | 'block' | 'unknown';

export function vezaLevel(code: string): VezaLevel {
  switch (String(code || '').trim()) {
    case 'Project': return 'order';
    case 'UnitItem': return 'unit';
    case 'MonoblockItem': return 'monoblock';
    case 'BlockItem': return 'block';
    default: return 'unknown';
  }
}

// ── Значимые узлы внутри блока ──────────────────────────────────────────────
//
// Ниже блока в выгрузке начинается производство: винты, уплотнитель погонными
// метрами, герметик миллилитрами, контроль сборки. Всё это правда о том, как
// изделие сделано, но в реестр оборудования не идёт — иначе реестром нельзя
// будет пользоваться.
//
// Между блоком и крепежом есть слой, ради которого этот список и написан:
// вентилятор, его двигатель, клапан, его привод. Именно им инженер присваивает
// теги («Таг-номер привода 3700-B01-DWD-001»), и без них тег некуда положить.
//
// Список закрытый. Незнакомый вид узла в реестр не попадает и НЕ выдумывается:
// он показывается в предпросмотре строкой «неизвестный вид», и решает человек.

/** Вид узла выгрузки → роль позиции (equipment/roles.ts). */
/**
 * Вид узла выгрузки → роль позиции.
 *
 * Список закрытый и собран по 23 настоящим выгрузкам: в них внутри блока
 * встречается ровно 33 вида узлов, и оборудованием из них является меньше
 * половины. Остальное — производство: ламели теплообменника, уголки вставки,
 * краска, заклёпки, отметки контроля качества.
 *
 * Чего в списке нет — в реестр не попадает. Незнакомый вид не выдумывается и
 * не пропадает молча: предпросмотр показывает его строкой «вид неизвестен» и
 * предлагает добавить в словарь. Выдумать роль один раз означает ошибаться в
 * ней всегда и тихо.
 */
export const VEZA_ROLES: Record<string, string> = {
  // Вентилятор и его двигатель. Сборка (`cadFanFreeAssem`) — позиция,
  // `cadFan` внутри неё — тот же вентилятор другими словами (см. VEZA_SAME_ROLE)
  cadFanFreeAssem: 'ВЕНТИЛЯТОР',
  cadFan: 'ВЕНТИЛЯТОР',
  cadEMotor: 'ДВИГАТЕЛЬ',

  // Клапан и его привод. Приводов у одного клапана бывает два
  cadConnAssem: 'КЛАПАН',
  cadConnAct: 'ПРИВОД',

  // Теплообменники: «DD» — тот же аппарат в обозначении для заказа
  cadHeater: 'НАГРЕВАТЕЛЬ',
  cadHeaterDD: 'НАГРЕВАТЕЛЬ',
  cadEHeater: 'НАГРЕВАТЕЛЬ',
  cadFrCooler: 'ОХЛАДИТЕЛЬ',
  cadFrCoolerDD: 'ОХЛАДИТЕЛЬ',

  // Обвязка: узел регулирования и дренажный бак — изделия с обозначением.
  // `cadTankTrap` сюда НЕ входит: этим видом помечены сифон, канализационная
  // труба и соединитель, то есть сборка слива, а не позиция реестра
  cadWaterSupply: 'ОБВЯЗКА',
  cadTank: 'ОБВЯЗКА',

  // Датчики. Реле перепада давления и капиллярный термостат — именно они, а
  // не «прочее»: их тегируют и по ним настраивают автоматику
  cadPressureDropSensor: 'ДАТЧИК',
  cadCapillaryThermostat: 'ДАТЧИК',

  // Оснащение блока
  cadLightSwitchKit: 'ОСНАЩЕНИЕ',
  cadServiceSwitchKit: 'ОСНАЩЕНИЕ',
  cadAirMeasuringHatchKit: 'ОСНАЩЕНИЕ',
};

/**
 * Виды, которые повторяют роль своего владельца, а не заводят вторую позицию.
 *
 * `cadFanFreeAssem` («Вентилятор ВОСК62-100-01500-06-1-Г-УХЛ2») содержит
 * `cadFan` («Вентилятор ВОСК62-100») — это один и тот же вентилятор, записанный
 * дважды: полным обозначением и типоразмером. Завести обе строки значило бы
 * удвоить вентиляторы в реестре и потребовать вдвое больше тегов.
 */
export const VEZA_SAME_ROLE = new Set(['cadFan', 'cadHeaterDD', 'cadFrCoolerDD']);

/**
 * Группа параметров → роль, которой эти параметры принадлежат.
 *
 * Параметров у подпозиции в выгрузке нет: собственной коллекции отчёта у
 * `cadEMotor` не бывает, всё лежит в коллекции блока разделами. Раздел
 * `ptgMOTOR` — это и есть данные двигателя, `ptgFAN` — вентилятора,
 * `ptgVARCONN` — клапана.
 *
 * Названы только те разделы, принадлежность которых очевидна из самого
 * названия. `ptgNOICE` (шум) сюда не входит: шумит блок целиком, и приписать
 * его вентилятору было бы догадкой.
 */
export const VEZA_GROUP_ROLES: Record<string, string[]> = {
  ptgFAN: ['ВЕНТИЛЯТОР'],
  ptgWORKPNT: ['ВЕНТИЛЯТОР'],
  ptgMOTOR: ['ДВИГАТЕЛЬ'],
  ptgEMOTORADJUST: ['ДВИГАТЕЛЬ'],
  ptgVARCONN: ['КЛАПАН'],
  ptgVARCONN1: ['КЛАПАН'],
  ptgVARCONN2: ['КЛАПАН'],
  ptgWATERSUPP: ['ОБВЯЗКА'],

  // Теплообменник один и тот же аппарат и в нагревателе, и в охладителе:
  // группа `ptgCOILS` лежит в обоих блоках, и приписать её одной роли значило
  // бы оставить вторую без данных
  ptgCOILS: ['НАГРЕВАТЕЛЬ', 'ОХЛАДИТЕЛЬ'],
  ptgWATER: ['НАГРЕВАТЕЛЬ', 'ОХЛАДИТЕЛЬ'],
  ptgDKIN: ['НАГРЕВАТЕЛЬ', 'ОХЛАДИТЕЛЬ'],
  ptgDKOUT: ['НАГРЕВАТЕЛЬ', 'ОХЛАДИТЕЛЬ'],
  ptgFREON: ['ОХЛАДИТЕЛЬ'],
  ptgFILTER: ['ФИЛЬТР'],
  ptgFILTERCELLS: ['ФИЛЬТР'],
};

/**
 * Узлы, которые заведомо НЕ позиции.
 *
 * Перечислены явно, чтобы «неизвестный вид» означал именно неизвестный, а не
 * «мы забыли про уплотнитель». Сюда попадает всё производственное: материалы,
 * крепёж, ламели, кассеты фильтра (их считает раздел `ptgFILTERCELLS` блока),
 * вставки и отметки контроля.
 */
export const VEZA_NOT_POSITIONS = new Set([
  'cadUntyped', 'cadMaterial', 'cadInnercarcassFolder', 'cadInnercarcassAssem',
  'cadQualityControlItem', 'cadQualContrAddToKitSpares', 'cadQualContrAddToKitMontage',
  'cadReportCollection', 'cadReportCollectionItem',
  'cadAddConnAssemSoft', 'cadAddConnAssemHard', 'cadAddConnConer',
  'cadBFilterCell', 'cadPFilterCell', 'cadCoilsFin', 'cadCoilsFlangeKit',
  'cadSealingRing', 'cadFreonCoilsDistribKit', 'cadTankTrap',
]);

/**
 * Параметр, который принадлежит не той позиции, что его раздел.
 *
 * Раздел `ptgVARCONN` — это клапан, но строка «Электропривод SM24-S2» в нём —
 * модель ПРИВОДА. Своих разделов у привода в выгрузке нет, и без этой строки
 * привод, ставший отдельной позицией, остался бы без единой характеристики.
 * Клапан параметр сохраняет: в его карточке он был и нужен там же. У привода
 * он называется так, как его ищут в таблице, — «Привод · Модель».
 */
export interface ParamRole {
  roles: string[];
  as?: Record<string, { group: string; key: string }>;
}
const ACTUATOR: ParamRole = { roles: ['КЛАПАН', 'ПРИВОД'], as: { ПРИВОД: { group: 'Привод', key: 'Модель' } } };
export const VEZA_PARAM_ROLES: Record<string, ParamRole> = {
  'ptgVARCONN.ptACTUATOR': ACTUATOR,
  'ptgVARCONN1.ptACTUATOR': ACTUATOR,
  'ptgVARCONN2.ptACTUATOR': ACTUATOR,
};

export const vezaParamRole = (group: string, type: string): ParamRole | null =>
  VEZA_PARAM_ROLES[`${String(group || '')}.${String(type || '')}`] || null;

/**
 * Сопоставления, заданные людьми: вид узла → роль или «не позиция».
 *
 * Выгрузку делает САПР, а он развивается: новый аппарат приезжает под новым
 * словом. Чинить это выпуском программы долго; человек, увидевший «вид
 * неизвестен» в предпросмотре, относит его к роли сам, и ответ живёт в общей
 * настройке компании. Здесь только правило, как его читать.
 */
export type KindMap = Record<string, string>;
export const SKIP_KIND = 'НЕ_ПОЗИЦИЯ';

/** Роль узла по его виду. Пусто — вид неизвестен или это не позиция. */
export function vezaRole(kind: string, extra?: KindMap): string {
  const k = String(kind || '');
  const own = extra?.[k];
  if (own) return own === SKIP_KIND ? '' : own;
  return VEZA_ROLES[k] || '';
}

/** Роли, которым принадлежит раздел параметров. Пусто — раздел про блок. */
export function vezaGroupRoles(group: string): string[] {
  return VEZA_GROUP_ROLES[String(group || '')] || [];
}

/** Значимый ли узел: позиция, «не позиция» или неизвестный вид. */
export function vezaKindSense(kind: string, extra?: KindMap): 'position' | 'skip' | 'unknown' {
  const k = String(kind || '');
  const own = extra?.[k];
  if (own) return own === SKIP_KIND ? 'skip' : 'position';
  if (VEZA_ROLES[k]) return 'position';
  if (VEZA_NOT_POSITIONS.has(k)) return 'skip';
  return 'unknown';
}
