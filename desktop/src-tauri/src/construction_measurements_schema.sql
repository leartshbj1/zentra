-- v78 : métré et chapitres des devis et factures (Pack bâtiment). Additif :
-- une ligne garde sa quantité ; le métré, s'il existe, la recalcule à
-- l'enregistrement. Le chapitre regroupe les lignes consécutives de même titre.
-- Les colonnes (section_title, measurements_json, show_measurements) sont
-- ajoutées par database::ensure_shared_step_columns, une seule fois, pour que
-- l'étape reste rejouable sur une base qui les possède déjà.
PRAGMA user_version=78;
