-- 查询未开票贷项/借项订单（VBAK + VBAP + TVAK + MARA）
-- VBTYP: K=贷项凭单请求, L=贷项凭单
-- 排除 Z 开头自建表

SELECT
  vbak.vbeln AS vbeln_js,
  vbak.vbtyp,
  vbak.auart AS lfart,
  vbkd_h.bstkd_e,
  tvak.fkara AS fkarv,
  vbak.vkorg,
  vbak.kunnr,
  vbak.kunnr AS kunnr_we,
  vbak.vgbel,
  vbap.posnr AS posnr_js,
  vbap.matnr,
  vbap.arktx AS maktx,
  mara.cust_draw_num,
  mara.oth_name,
  mara.spec,
  mara.sale_type,
  CASE WHEN vbak.vbtyp = 'K' THEN 0 - vbap.zmeng
       WHEN vbak.vbtyp = 'L' THEN vbap.zmeng
       ELSE vbap.kwmeng
  END AS lfimg,
  vbap.vrkme,
  vbap.fksaa AS fksta,
  vbak.waerk,
  vbap.netwr AS zprice_d,
  vbkd_h.zterm,
  vbap.werks,
  vbap.lgort,
  vbap.netwr,
  vbak.vtweg
FROM vbak
INNER JOIN vbap ON vbap.vbeln = vbak.vbeln
INNER JOIN tvak ON tvak.auart = vbak.auart
INNER JOIN mara ON mara.matnr = vbap.matnr
LEFT JOIN vbkd AS vbkd_h
  ON vbkd_h.vbeln = vbap.vbeln
  AND vbkd_h.posnr = '000000'
WHERE vbak.vbtyp IN ('K', 'L')
  AND vbak.vkorg IN @s_vkorg
  AND vbak.kunnr IN @s_kunnr
  AND vbak.auart IN @s_lfart
  AND vbak.vbeln IN @s_vbeln
  AND vbap.matnr IN @s_matnr
  AND mara.cust_draw_num IN @s_drawn
  AND vbap.fksaa IN @s_fksta
  AND vbap.abgru = ''
