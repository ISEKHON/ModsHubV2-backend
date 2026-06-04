-- CreateIndex
CREATE INDEX "activity_log_user_id_type_idx" ON "activity_log"("user_id", "type");

-- CreateIndex
CREATE INDEX "activity_log_type_created_at_idx" ON "activity_log"("type", "created_at");

-- CreateIndex
CREATE INDEX "mods_status_created_at_idx" ON "mods"("status", "created_at");

-- CreateIndex
CREATE INDEX "mods_status_featured_idx" ON "mods"("status", "featured");

-- CreateIndex
CREATE INDEX "mods_status_downloads_idx" ON "mods"("status", "downloads");

-- CreateIndex
CREATE INDEX "mods_status_views_idx" ON "mods"("status", "views");

-- CreateIndex
CREATE INDEX "mods_status_likes_count_idx" ON "mods"("status", "likes_count");

-- CreateIndex
CREATE INDEX "mods_game_status_idx" ON "mods"("game", "status");

-- CreateIndex
CREATE INDEX "mods_category_status_idx" ON "mods"("category", "status");

-- CreateIndex
CREATE INDEX "mods_author_id_idx" ON "mods"("author_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_created_at_idx" ON "notifications"("user_id", "is_read", "created_at");
