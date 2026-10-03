-- Participants are optional since #198: older decisions must not keep them as a missing field.
UPDATE `decisions` SET `missing_fields` = (SELECT json_group_array(`value`) FROM json_each(`decisions`.`missing_fields`) WHERE `value` <> 'participants') WHERE json_valid(`missing_fields`) AND instr(`missing_fields`, '"participants"') > 0;
