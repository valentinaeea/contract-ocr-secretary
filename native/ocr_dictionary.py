"""Extract the exact CTC vocabulary embedded in RapidOCR ONNX recognition models."""
def dictionary_from_sessions(sessions):
    selected=None
    for session in sessions:
        raw=session.get_modelmeta().custom_metadata_map.get('character')
        if not isinstance(raw,str) or not raw:
            raise ValueError('Recognition model has no embedded character dictionary')
        keys=raw.splitlines()
        classes=session.get_outputs()[0].shape[-1]
        # RapidOCR inserts CTC blank at the front and space at the end.
        if isinstance(classes,int) and classes!=len(keys)+2:
            raise ValueError(f'CTC output has {classes} classes but dictionary implies {len(keys)+2}')
        if selected is not None and keys!=selected:
            raise ValueError('Mobile and server recognition dictionaries differ')
        selected=keys
    if selected is None:raise ValueError('No recognition models supplied')
    return selected
