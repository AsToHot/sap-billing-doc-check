-- 查询未开票交货单（LIKP + LIPS + MARA）
-- 排除 Z 开头自建表，仅使用 SAP 标准表
-- 参照原对账开票逻辑：wbstk='C' 表示已过账

SELECT
  likp.vbeln AS vbeln_js,
  likp.vbtyp,
  likp.lfart,
  likp.fkarv,
  likp.vkorg,
  likp.kunag AS kunnr,
  likp.kunnr AS kunnr_we,
  likp.wadat_ist,
  lips.posnr AS posnr_js,
  lips.matnr,
  lips.arktx AS maktx,
  mara.cust_draw_num,
  mara.oth_name,
  mara.spec,
  mara.sale_type,
  CASE WHEN likp.vbtyp = 'T'
       THEN 0 - lips.lfimg
       ELSE lips.lfimg
  END AS lfimg,
  lips.vrkme,
  lips.fksta,
  likp.waerk,
  likp.inco1,
  lips.vgbel,
  lips.vgpos,
  lips.werks,
  lips.lgort,
  lips.vtweg
FROM likp
INNER JOIN lips ON lips.vbeln = likp.vbeln
INNER JOIN mara ON mara.matnr = lips.matnr
WHERE likp.wbstk = 'C'
  AND likp.vkorg IN @s_vkorg
  AND likp.kunnr IN @s_kunnr
  AND likp.lfart IN @s_lfart
  AND likp.wadat_ist IN @s_wadat
  AND likp.vbeln IN @s_vbeln
  AND lips.matnr IN @s_matnr
  AND mara.cust_draw_num IN @s_drawn
  AND lips.fksta IN @s_fksta
