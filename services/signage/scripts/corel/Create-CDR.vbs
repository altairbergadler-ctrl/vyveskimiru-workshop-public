Option Explicit
' Data is read only from layout.xml. No input is evaluated or used as code.
' Requires the licensed Windows CorelDRAW 2024 application (COM major 25).
Dim app, doc, fso, folder, quiet, openAfter, resultPath, errorNumber, errorMessage
Set app = Nothing
Set doc = Nothing
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
quiet = WScript.Arguments.Named.Exists("quiet")
openAfter = WScript.Arguments.Named.Exists("open")
On Error Resume Next
Main
errorNumber = Err.Number
errorMessage = Err.Description
On Error GoTo 0
If errorNumber <> 0 Then
  If quiet Then
    WScript.Echo "ERROR: " & errorMessage
  Else
    MsgBox "CDR не создан: " & errorMessage, 16, "Макет лицевой части"
  End If
  WScript.Quit 1
End If
If quiet Then
  WScript.Echo resultPath
Else
  MsgBox "Создан CDR с буквами в кривых:" & vbCrLf & resultPath & vbCrLf & vbCrLf & _
    "Фактические размеры записаны в соседний TXT. Проверьте макет перед изготовлением.", 64, "Макет лицевой части"
End If

Sub Fail(message)
  Err.Raise 513, "Signage Corel export", message
End Sub

Function Value(xml, name)
  Dim node
  Set node = xml.selectSingleNode("/signage/" & name)
  If node Is Nothing Then Fail "В layout.xml отсутствует поле " & name
  Value = node.text
End Function

Function NumberValue(xml, name, allowZero)
  Dim raw, pattern, valueNumber, separator
  raw = Value(xml, name)
  Set pattern = New RegExp
  pattern.Pattern = "^[0-9]+([.][0-9]+)?$"
  If Not pattern.Test(raw) Then Fail "Некорректное число: " & name
  separator = Mid(CStr(1.5), 2, 1)
  valueNumber = CDbl(Replace(raw, ".", separator))
  If valueNumber < 0 Or valueNumber > 10000 Then Fail "Размер вне допустимого диапазона: " & name
  If Not allowZero And valueNumber = 0 Then Fail "Размер должен быть больше нуля: " & name
  NumberValue = valueNumber
End Function

Function TwoDigits(n)
  TwoDigits = Right("0" & CStr(n), 2)
End Function

Sub Main
  Dim inputPath, xml, rows, width, height, gap, alignment, fontName, boldText, boldState
  Dim color, pattern, found, i, count, totalCharacters, shapes(), widths(), heights()
  Dim shape, largestHeight, largestWidth, totalHeight, scale, heightScale, actualHeight
  Dim top, left, opt, stamp, outputBase, suffix, reportText, outReport, n, fontItem
  inputPath = fso.BuildPath(folder, "layout.xml")
  If Not fso.FileExists(inputPath) Then Fail "Распакуйте ZIP целиком: рядом со скриптом нужен layout.xml."
  If fso.GetFile(inputPath).Size > 65536 Then Fail "layout.xml слишком большой."
  Set xml = CreateObject("Msxml2.DOMDocument.6.0")
  xml.async = False
  xml.validateOnParse = False
  xml.resolveExternals = False
  xml.preserveWhiteSpace = True
  xml.setProperty "ProhibitDTD", True
  If Not xml.Load(inputPath) Then Fail "Не удалось прочитать layout.xml."
  If xml.documentElement.nodeName <> "signage" Then Fail "Неверный формат макета."
  If xml.documentElement.getAttribute("version") <> "1" Then Fail "Неподдерживаемая версия макета."
  width = NumberValue(xml, "width_cm", False)
  height = NumberValue(xml, "height_cm", False)
  gap = NumberValue(xml, "line_gap_cm", True)
  alignment = Value(xml, "text_align")
  If alignment <> "left" And alignment <> "center" And alignment <> "right" Then Fail "Неизвестное выравнивание."
  fontName = Trim(Value(xml, "font_family"))
  If Len(fontName) < 1 Or Len(fontName) > 120 Then Fail "Укажите имя шрифта."
  boldText = Value(xml, "font_bold")
  If boldText <> "true" And boldText <> "false" Then Fail "Неверное начертание."
  boldState = 0
  If boldText = "true" Then boldState = -1 ' cdrTrue
  color = Value(xml, "front_color")
  Set pattern = New RegExp
  pattern.Pattern = "^#[0-9A-Fa-f]{6}$"
  If Not pattern.Test(color) Then Fail "Неверный цвет лицевой части."
  Set rows = xml.selectNodes("/signage/lines/line")
  count = rows.length
  If count < 1 Or count > 20 Then Fail "Допустимо от 1 до 20 строк."
  If (count - 1) * gap >= height Then Fail "Межстрочные зазоры занимают всю высоту."
  totalCharacters = count - 1
  For i = 0 To count - 1
    totalCharacters = totalCharacters + Len(rows.Item(i).text)
  Next
  If totalCharacters > 300 Then Fail "В надписи более 300 символов."

  Set app = CreateObject("CorelDRAW.Application.25")
  found = False
  For i = 1 To app.FontList.Count
    fontItem = app.FontList.Item(i)
    If StrComp(fontItem, fontName, 1) = 0 Then
      fontName = fontItem
      found = True
      Exit For
    End If
  Next
  If Not found Then Fail "В CorelDRAW отсутствует шрифт «" & fontName & "». Установите его или укажите доступный шрифт."
  Set doc = app.CreateDocument()
  doc.Unit = 4 ' cdrCentimeter
  doc.ActivePage.SetSize width, height
  doc.DrawingOriginX = 0
  doc.DrawingOriginY = 0
  ReDim shapes(count - 1)
  ReDim widths(count - 1)
  ReDim heights(count - 1)
  largestWidth = 0
  largestHeight = 0
  For i = 0 To count - 1
    Set shapes(i) = Nothing
    If Len(Trim(rows.Item(i).text)) > 0 Then
      Set shape = doc.ActiveLayer.CreateArtisticText(0, 0, rows.Item(i).text, , , fontName, 100, boldState, 0)
      shape.ConvertToCurves
      shape.Name = "Строка " & CStr(i + 1)
      shape.Outline.SetNoOutline
      shape.Fill.ApplyUniformFill app.CreateRGBColor(CLng("&H" & Mid(color, 2, 2)), CLng("&H" & Mid(color, 4, 2)), CLng("&H" & Mid(color, 6, 2)))
      Set shapes(i) = shape
      widths(i) = shape.SizeWidth
      heights(i) = shape.SizeHeight
      If widths(i) <= 0 Or heights(i) <= 0 Then Fail "Не удалось измерить контуры строки " & CStr(i + 1)
      If widths(i) > largestWidth Then largestWidth = widths(i)
      If heights(i) > largestHeight Then largestHeight = heights(i)
    End If
  Next
  If largestWidth = 0 Or largestHeight = 0 Then Fail "Надпись не содержит видимых букв."
  totalHeight = 0
  For i = 0 To count - 1
    If shapes(i) Is Nothing Then heights(i) = largestHeight
    totalHeight = totalHeight + heights(i)
  Next
  scale = width / largestWidth
  heightScale = (height - (count - 1) * gap) / totalHeight
  If heightScale < scale Then scale = heightScale
  actualHeight = totalHeight * scale + (count - 1) * gap
  ' New pages may be centered in Corel's drawing space. Always use page bounds.
  top = doc.ActivePage.TopY - (height - actualHeight) / 2
  reportText = "Лицевая часть букв. Масштаб 1:1, единицы — сантиметры." & vbCrLf & _
    "Шрифт: " & fontName & "; Bold: " & boldText & vbCrLf & _
    "Габарит страницы: " & width & " x " & height & " см" & vbCrLf & _
    "Габарит композиции: " & Round(largestWidth * scale, 4) & " x " & Round(actualHeight, 4) & " см" & vbCrLf & _
    "Межстрочный зазор: " & gap & " см; цвет RGB: " & color & vbCrLf & _
    "Буквы пропорционально вписаны в заданный габарит; растяжение по отдельным осям не применялось." & vbCrLf
  For i = 0 To count - 1
    If Not (shapes(i) Is Nothing) Then
      Set shape = shapes(i)
      shape.Stretch scale, scale
      left = (width - shape.SizeWidth) / 2
      If alignment = "left" Then left = 0
      If alignment = "right" Then left = width - shape.SizeWidth
      shape.LeftX = doc.ActivePage.LeftX + left
      shape.TopY = top
      reportText = reportText & "Строка " & (i + 1) & ": " & Round(shape.SizeWidth, 4) & " x " & Round(shape.SizeHeight, 4) & " см; " & rows.Item(i).text & vbCrLf
    Else
      reportText = reportText & "Строка " & (i + 1) & ": пустая, высота " & Round(heights(i) * scale, 4) & " см" & vbCrLf
    End If
    top = top - heights(i) * scale - gap
  Next
  stamp = Year(Now) & TwoDigits(Month(Now)) & TwoDigits(Day(Now)) & "-" & TwoDigits(Hour(Now)) & TwoDigits(Minute(Now)) & TwoDigits(Second(Now))
  outputBase = fso.BuildPath(folder, "face-letters-" & stamp)
  resultPath = outputBase & ".cdr"
  suffix = 0
  Do While fso.FileExists(resultPath) Or fso.FileExists(outputBase & ".txt")
    suffix = suffix + 1
    outputBase = fso.BuildPath(folder, "face-letters-" & stamp & "-" & suffix)
    resultPath = outputBase & ".cdr"
  Loop
  Set opt = app.CreateStructSaveAsOptions()
  opt.Filter = 1795 ' cdrCDR
  opt.EmbedVBAProject = False
  opt.Overwrite = False
  doc.SaveAs resultPath, opt
  If Not fso.FileExists(resultPath) Then Fail "CorelDRAW не сохранил CDR."
  Set outReport = fso.CreateTextFile(outputBase & ".txt", False, True)
  outReport.Write reportText & vbCrLf & "Цвет HEX — экранный образец, не подтверждённая цветопроба плёнки. Припуски и компенсация реза не добавлялись."
  outReport.Close
  If quiet And Not openAfter Then
    doc.Close
  Else
    app.Visible = True
    doc.Activate
    app.ActiveWindow.ActiveView.ToFitAllObjects
  End If
End Sub
