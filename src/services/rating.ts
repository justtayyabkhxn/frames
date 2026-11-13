import axios from '@nextcloud/axios';

import { API } from '@services/API';
import * as utils from '@services/utils/common';

/** Write a 0-5 star rating (0 clears) into the file's XMP and refresh views of it. */
export async function setRating(fileid: number, rating: number) {
  try {
    await axios.patch(API.IMAGE_SETEXIF(fileid), { raw: { Rating: rating } });
    utils.bus.emit('files:file:updated', { fileid });
  } catch (e: any) {
    utils.showError(e?.response?.data?.message ?? String(e));
  }
}
