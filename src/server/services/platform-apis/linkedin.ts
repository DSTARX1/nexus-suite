import { randomUUID } from "node:crypto";
import { downloadFile } from "../r2-storage";
import type { PostResult, VariationData } from "../posting";

const LINKEDIN_API = "https://api.linkedin.com/v2";

export async function postLinkedInApi(
  accessToken: string,
  variation: VariationData,
): Promise<PostResult> {
  if (process.env.MOCK_PLATFORM_APIS === "true") {
    return { success: true, externalPostId: `mock_linkedin_${randomUUID()}` };
  }

  if (!variation.r2StorageKey) {
    return { success: false, errorMessage: "No r2StorageKey on variation" };
  }

  const buffer = await downloadFile(variation.r2StorageKey);

  // Step 1: Register upload — get asset URN and upload URL
  const ownerUrn = `urn:li:person:me`;
  const registerRes = await fetch(`${LINKEDIN_API}/assets?action=registerUpload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      registerUploadRequest: {
        owner: ownerUrn,
        recipes: ["urn:li:digitalmediaRecipe:feedshare-video"],
        serviceRelationships: [
          {
            identifier: "urn:li:userGeneratedContent",
            relationshipType: "OWNER",
          },
        ],
      },
    }),
  });

  if (!registerRes.ok) {
    const body = await registerRes.text();
    return {
      success: false,
      errorMessage: `LinkedIn register upload failed (${registerRes.status}): ${body}`,
    };
  }

  const registerData = (await registerRes.json()) as {
    value?: {
      asset?: string;
      uploadMechanism?: {
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"?: {
          uploadUrl?: string;
        };
      };
    };
  };

  const asset = registerData.value?.asset;
  const uploadUrl =
    registerData.value?.uploadMechanism?.[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ]?.uploadUrl;

  if (!asset || !uploadUrl) {
    return {
      success: false,
      errorMessage: "LinkedIn did not return asset or uploadUrl",
    };
  }

  // Step 2: Upload video binary
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buffer.length),
    },
    body: new Uint8Array(buffer),
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    return {
      success: false,
      errorMessage: `LinkedIn upload failed (${uploadRes.status}): ${body}`,
    };
  }

  // Step 3: Create UGC post with the uploaded asset
  const ugcRes = await fetch(`${LINKEDIN_API}/ugcPosts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: ownerUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: {
            text: variation.caption ?? "",
          },
          shareMediaCategory: "VIDEO",
          media: [
            {
              status: "READY",
              media: asset,
            },
          ],
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    }),
  });

  if (!ugcRes.ok) {
    const body = await ugcRes.text();
    return {
      success: false,
      errorMessage: `LinkedIn UGC post failed (${ugcRes.status}): ${body}`,
    };
  }

  const ugcData = (await ugcRes.json()) as { id?: string };

  if (!ugcData.id) {
    return { success: false, errorMessage: "LinkedIn response missing post id" };
  }

  return { success: true, externalPostId: ugcData.id };
}
