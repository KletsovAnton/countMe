import { zipSync, strToU8 } from 'fflate';

// ==================== ЭКСПОРТ В CSV И EXCEL ====================

export const EXPORT_COLUMNS = [
    { key: 'receiptDate', title: 'Дата' },
    { key: 'shop', title: 'Магазин' },
    { key: 'name', title: 'Позиция' },
    { key: 'originalName', title: 'Название в чеке' },
    { key: 'category', title: 'Категория' },
    { key: 'originalPrice', title: 'Сумма', number: true },
    { key: 'currency', title: 'Валюта' },
    { key: 'priceRub', title: 'Сумма, ₽', number: true },
    { key: 'rateDate', title: 'Курс на дату' },
];

export function buildExportRows(items) {
    return [...items]
        .sort((a, b) => (b.receiptDate || '').localeCompare(a.receiptDate || '') || (b.createdAt || '').localeCompare(a.createdAt || ''))
        .map(item => {
            const row = {};
            for (const col of EXPORT_COLUMNS) {
                const value = item[col.key];
                row[col.key] = col.number
                    ? (value === null || value === undefined || value === '' ? null : Math.round(Number(value) * 100) / 100)
                    : String(value ?? '');
            }
            return row;
        });
}

// CSV для Excel с русской локалью: разделитель «;», десятичная запятая, BOM для UTF-8
export function toCsv(rows) {
    const escape = (value) => {
        const s = String(value ?? '');
        return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [EXPORT_COLUMNS.map(c => escape(c.title)).join(';')];
    for (const row of rows) {
        lines.push(EXPORT_COLUMNS.map(c => {
            const v = row[c.key];
            if (c.number) return v === null ? '' : String(v).replace('.', ',');
            return escape(v);
        }).join(';'));
    }
    return '﻿' + lines.join('\r\n');
}

const xmlEscape = (s) => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnLetter(index) {
    let n = index + 1;
    let letters = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        letters = String.fromCharCode(65 + rem) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return letters;
}

// Минимальный .xlsx: один лист, строки как inline-строки, числа как числа, шапка закреплена
export function toXlsx(rows) {
    const cell = (value, colIdx, rowIdx, isNumber, style = 0) => {
        const ref = `${columnLetter(colIdx)}${rowIdx}`;
        const s = style ? ` s="${style}"` : '';
        if (isNumber) return value === null ? `<c r="${ref}"${s}/>` : `<c r="${ref}"${s}><v>${value}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    };
    const header = `<row r="1">${EXPORT_COLUMNS.map((c, i) => cell(c.title, i, 1, false, 1)).join('')}</row>`;
    const body = rows.map((row, r) =>
        `<row r="${r + 2}">${EXPORT_COLUMNS.map((c, i) => cell(row[c.key], i, r + 2, c.number, c.number ? 2 : 0)).join('')}</row>`
    ).join('');
    const widths = [12, 22, 28, 28, 20, 12, 8, 14, 13];
    const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;

    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${header}${body}</sheetData><autoFilter ref="A1:${columnLetter(EXPORT_COLUMNS.length - 1)}${rows.length + 1}"/></worksheet>`;

    const files = {
        '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Траты" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Траты'!$A$1:$${columnLetter(EXPORT_COLUMNS.length - 1)}$${rows.length + 1}</definedName></definedNames></workbook>`,
        'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
        'xl/worksheets/sheet1.xml': sheet,
    };
    const zipInput = {};
    for (const [path, content] of Object.entries(files)) zipInput[path] = strToU8(content);
    return zipSync(zipInput, { level: 6 });
}

// На iPhone (в том числе в установленном приложении) файл отдаётся через меню «Поделиться»
export async function deliverFile(data, filename, mimeType) {
    const file = new File([data], filename, { type: mimeType });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: filename });
            return 'shared';
        } catch (err) {
            if (err.name === 'AbortError') return 'cancelled';
        }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'downloaded';
}
