module.exports = (sequelize, DataTypes) => {
  const Holiday = sequelize.define(
    'Holiday',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      branch_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      is_recurring: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
    },
    {
      tableName: 'holidays',
      paranoid: true,
      underscored: true,
    }
  );

  Holiday.associate = (models) => {
    Holiday.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    Holiday.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch' });
  };

  return Holiday;
};
